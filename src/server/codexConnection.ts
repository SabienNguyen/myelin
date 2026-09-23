import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { credentialsPath } from './credentials.js';

const require = createRequire(import.meta.url);
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type CodexStatus = { connected: boolean; plan: string | null };
export type CodexLogin = { url: string; code: string };

/** A JSON-RPC error from the app-server. `code` is the protocol's numeric error code; `message`
 * always stays the fixed generic text below, never the provider's own error message, which may
 * contain token-bearing URLs.
 */
export class CodexRpcError extends Error {
  readonly code: number;
  constructor(code: number) {
    super('Codex rejected the request. Check your account access and try again.');
    this.name = 'CodexRpcError';
    this.code = code;
  }
}

/** Official Codex app-server owns OAuth and refresh. Never read/export its credential file.
 * A Myelin-only home avoids inheriting a CLI login, custom provider, MCP servers or API key.
 * Exposes a generic `request` for callers like codexTurn to run model turns over, but still
 * answers every server->client request with "unsupported" here: no tool execution or approval
 * handling exists in this connection.
 */
export class CodexConnection {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private starting?: Promise<void>;
  private closed = false;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private login?: CodexLogin;
  private loginId?: string;
  private loginError?: string;
  readonly home: string;

  constructor(opts: { home?: string } = {}) {
    this.home = opts.home ?? join(dirname(credentialsPath()), 'codex');
  }

  private failPending(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }

  private send(method: string, params: unknown): Promise<any> {
    if (!this.child || this.closed) return Promise.reject(new Error('Codex connection is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Reopen the connection and try again.`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not write to Codex. Reopen the connection and try again.'));
      });
    });
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error('Codex connection is closed.');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const cli = require.resolve('@openai/codex/bin/codex.js');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: this.home,
        USERPROFILE: this.home,
        XDG_CONFIG_HOME: this.home,
        CODEX_HOME: this.home,
        // Required by Windows process/network setup; not credential/provider settings.
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ELECTRON_RUN_AS_NODE: '1',
      };
      this.child = spawn(process.execPath, [cli, 'app-server', '-c', 'cli_auth_credentials_store="file"'], {
        cwd: this.home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      // Protocol messages can contain credentials/login codes. Never log either pipe.
      this.child.stderr.resume();
      this.child.stdin.on('error', () => this.failPending('Codex connection closed.'));
      this.child.on('error', () => this.failPending('Could not start Codex. Check the @openai/codex installation.'));
      this.child.on('exit', () => {
        this.failPending('Codex exited. Reopen the connection and try again.');
        this.starting = undefined;
        this.child = undefined;
        this.login = undefined;
        this.loginId = undefined;
      });
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on('line', line => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.method === 'account/login/completed') {
          this.login = undefined;
          this.loginId = undefined;
          this.loginError = msg.params?.success ? undefined : 'ChatGPT sign-in failed or expired. Try signing in again.';
          return;
        }
        if (msg.method && msg.id !== undefined) {
          // Auth-only connection: no approvals, tool execution or external token refresh handlers.
          this.child?.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Unsupported client request' } }) + '\n');
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        // Don't return provider error text: it may contain token-bearing URLs.
        if (msg.error) p.reject(new CodexRpcError(typeof msg.error.code === 'number' ? msg.error.code : -32603));
        else p.resolve(msg.result);
      });
      await this.send('initialize', { clientInfo: { name: 'myelin', version: '0.3.1' }, capabilities: null });
      this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    })();
    try { await this.starting; } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Generic RPC for callers like codexTurn that need methods beyond authentication
   * (e.g. thread/turn management). JSON-RPC errors reject with CodexRpcError via send().
   */
  async request(method: string, params: unknown): Promise<any> {
    await this.start();
    return this.send(method, params);
  }

  async status(): Promise<CodexStatus> {
    await this.start();
    const result = await this.send('account/read', { refreshToken: false });
    return {
      connected: result.account?.type === 'chatgpt',
      plan: result.account?.type === 'chatgpt' ? result.account.planType ?? null : null,
    };
  }

  async beginLogin(): Promise<CodexLogin> {
    await this.start();
    if (this.login) return this.login;
    this.loginError = undefined;
    const result = await this.send('account/login/start', { type: 'chatgptDeviceCode' });
    if (result.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string'
      || typeof result.verificationUrl !== 'string' || typeof result.userCode !== 'string') {
      throw new Error('Codex did not return a device sign-in. Update Codex and try again.');
    }
    const url = new URL(result.verificationUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) {
      throw new Error('Codex returned an unexpected sign-in address.');
    }
    this.loginId = result.loginId;
    this.login = { url: url.href, code: result.userCode };
    return this.login;
  }

  async disconnect(): Promise<void> {
    await this.start();
    if (this.loginId) await this.send('account/login/cancel', { loginId: this.loginId });
    await this.send('account/logout', {});
    this.login = undefined;
    this.loginId = undefined;
    this.loginError = undefined;
  }

  get signInError(): string | undefined { return this.loginError; }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.failPending('Codex connection closed.');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
      child.kill('SIGTERM');
    });
    this.lines?.close();
  }
}
