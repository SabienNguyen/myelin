// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClusterSandbox } from '../../src/client/components/blocks/gap/ClusterSandbox.js';

const SANDBOX = {
  namespace: 'mx-cka-unready-pods',
  kubeconfig: '/vault/.harness/kube/myelin.kubeconfig',
  command: "export KUBECONFIG='/vault/.harness/kube/myelin.kubeconfig' && kubectl config set-context --current --namespace=mx-cka-unready-pods",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ClusterSandbox', () => {
  it('shows the one command that points a terminal at this exercise, and its namespace', () => {
    render(<ClusterSandbox pattern="cka-unready-pods" sandbox={SANDBOX} onReset={() => {}} />);
    expect(screen.getByText(SANDBOX.command)).toBeTruthy();
    expect(screen.getByText('mx-cka-unready-pods')).toBeTruthy();
  });

  it('copies the command', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<ClusterSandbox pattern="cka-unready-pods" sandbox={SANDBOX} onReset={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SANDBOX.command));
    expect(await screen.findByRole('button', { name: 'copied' })).toBeTruthy();
  });

  it('reset posts the pattern, says it is working, then re-checks', async () => {
    let release!: () => void;
    const fetchMock = vi.fn(() => new Promise((r) => { release = () => r({ ok: true, json: async () => ({ ok: true }) }); }));
    vi.stubGlobal('fetch', fetchMock);
    const onReset = vi.fn();
    render(<ClusterSandbox pattern="cka-unready-pods" sandbox={SANDBOX} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: 'reset sandbox' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/resetting/);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body))).toEqual({ pattern: 'cka-unready-pods' });
    release();
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
  });

  it('names the failure when a reset does not work', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'start the Docker daemon' }) })));
    const onReset = vi.fn();
    render(<ClusterSandbox pattern="cka-unready-pods" sandbox={SANDBOX} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: 'reset sandbox' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/reset failed: start the Docker daemon/);
    expect(onReset).not.toHaveBeenCalled();
  });
});
