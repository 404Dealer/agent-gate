import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DraftSchema } from '../schema.js';
import { decodeUniqueInboxReferences } from './reference.js';

export interface TrashProposalResult {
  proposalId: string;
  status: 'pending-approval';
}

export async function submitTrashProposal(
  inboxDirectory: string,
  refs: readonly string[],
  context: string
): Promise<TrashProposalResult> {
  decodeUniqueInboxReferences(refs);

  const proposalId = randomUUID();
  const now = new Date().toISOString();
  const draft = DraftSchema.parse({
    id: proposalId,
    type: 'mailbox-trash',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    source: 'hermes-agent-mailbox-broker',
    provider: 'gmail-smtp',
    payload: { refs },
    metadata: {
      context,
      priority: 'normal',
      tags: ['mailbox', 'trash']
    }
  });
  const temporaryPath = resolve(inboxDirectory, `.${proposalId}.tmp`);
  const finalPath = resolve(inboxDirectory, `${proposalId}.json`);
  try {
    await writeFile(temporaryPath, JSON.stringify(draft, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { proposalId, status: 'pending-approval' };
}
