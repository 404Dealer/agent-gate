import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DraftSchema } from '../schema.js';
import { decodeInboxReference } from './reference.js';

export interface UnsubscribeProposalResult {
  proposalId: string;
  status: 'pending-approval';
}

export async function submitUnsubscribeProposal(
  inboxDirectory: string,
  ref: string,
  context: string,
  provider = 'gmail-smtp'
): Promise<UnsubscribeProposalResult> {
  decodeInboxReference(ref);
  const proposalId = randomUUID();
  const now = new Date().toISOString();
  const draft = DraftSchema.parse({
    id: proposalId,
    type: 'mailbox-unsubscribe',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    source: 'hermes-agent-mailbox-broker',
    provider,
    payload: { ref },
    metadata: {
      context,
      priority: 'normal',
      tags: ['mailbox', 'unsubscribe']
    }
  });
  const temporaryPath = resolve(inboxDirectory, `.${proposalId}.tmp`);
  const finalPath = resolve(inboxDirectory, `${proposalId}.json`);
  try {
    await writeFile(temporaryPath, JSON.stringify(draft, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { proposalId, status: 'pending-approval' };
}
