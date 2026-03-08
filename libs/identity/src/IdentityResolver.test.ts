import { describe, it, expect, vi } from 'vitest';
import { IdentityResolver } from './IdentityResolver';
import type { IdentityGraph } from './types';

function mockGraph(existing: Record<string, string> = {}): IdentityGraph {
  const store = new Map(Object.entries(existing));
  return {
    resolveUserId: vi.fn(async (anonId: string) => store.get(anonId) ?? null),
    link: vi.fn(async (anonId: string, userId: string) => { store.set(anonId, userId); }),
  };
}

describe('IdentityResolver', () => {
  it('links anonymousId to userId when both present', async () => {
    const graph = mockGraph();
    const resolver = new IdentityResolver(graph);
    const result = await resolver.resolve({
      type: 'identify',
      userId: 'user_1',
      anonymousId: 'anon_1',
      messageId: 'msg_1',
      timestamp: '2024-01-01T00:00:00.000Z',
    } as any);
    expect(result.isNewLink).toBe(true);
    expect(result.userId).toBe('user_1');
    expect(graph.link).toHaveBeenCalledWith('anon_1', 'user_1');
  });

  it('does not re-link if same mapping exists', async () => {
    const graph = mockGraph({ anon_1: 'user_1' });
    const resolver = new IdentityResolver(graph);
    const result = await resolver.resolve({
      type: 'track',
      event: 'click',
      userId: 'user_1',
      anonymousId: 'anon_1',
      messageId: 'msg_2',
      timestamp: '2024-01-01T00:00:00.000Z',
    } as any);
    expect(result.isNewLink).toBe(false);
    expect(graph.link).not.toHaveBeenCalled();
  });

  it('resolves anonymousId-only events', async () => {
    const graph = mockGraph({ anon_1: 'user_1' });
    const resolver = new IdentityResolver(graph);
    const result = await resolver.resolve({
      type: 'page',
      anonymousId: 'anon_1',
      messageId: 'msg_3',
      timestamp: '2024-01-01T00:00:00.000Z',
    } as any);
    expect(result.userId).toBe('user_1');
    expect(result.isNewLink).toBe(false);
  });

  it('returns null userId for unknown anonymous', async () => {
    const graph = mockGraph();
    const resolver = new IdentityResolver(graph);
    const result = await resolver.resolve({
      type: 'page',
      anonymousId: 'anon_unknown',
      messageId: 'msg_4',
      timestamp: '2024-01-01T00:00:00.000Z',
    } as any);
    expect(result.userId).toBeNull();
  });

  it('handles userId-only events', async () => {
    const graph = mockGraph();
    const resolver = new IdentityResolver(graph);
    const result = await resolver.resolve({
      type: 'track',
      event: 'purchase',
      userId: 'user_2',
      messageId: 'msg_5',
      timestamp: '2024-01-01T00:00:00.000Z',
    } as any);
    expect(result.userId).toBe('user_2');
    expect(result.anonymousId).toBeNull();
  });
});
