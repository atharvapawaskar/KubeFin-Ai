import type { RedisClientType } from 'redis';
import type { DeadLetterRecord, StreamEntry, UsageStreamPort } from './stream-consumer.js';

const deadLetterAndAckScript = `
local pending = redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1)
if #pending == 0 then
  return 0
end
local fields = {
  'sourceStream', ARGV[3],
  'sourceEntryId', ARGV[2],
  'failedAt', ARGV[4],
  'failureCode', ARGV[5],
  'attempts', ARGV[6],
  'payloadBytes', ARGV[7],
  'payloadSha256', ARGV[8]
}
if ARGV[9] == '1' then
  table.insert(fields, 'payload')
  table.insert(fields, ARGV[10])
end
redis.call('XADD', KEYS[2], '*', unpack(fields))
return redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
`;

export class RedisUsageStreamPort implements UsageStreamPort {
  constructor(
    private readonly client: RedisClientType,
    private readonly deadLetterStream: string,
  ) {}

  async createGroup(stream: string, group: string): Promise<void> {
    try {
      await this.client.xGroupCreate(stream, group, '0', { MKSTREAM: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes('BUSYGROUP')) return;
      throw error;
    }
  }

  async readNew(
    stream: string,
    group: string,
    consumer: string,
    count: number,
    blockMs: number,
  ): Promise<StreamEntry[]> {
    const result = await this.client.xReadGroup(
      group,
      consumer,
      [{ key: stream, id: '>' }],
      { COUNT: count, BLOCK: blockMs },
    );
    if (!result) return [];
    return result.flatMap(({ messages }) => messages.map(toStreamEntry));
  }

  async claimPending(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    startId: string,
    count: number,
  ): Promise<{ nextId: string; entries: StreamEntry[]; deletedIds: string[] }> {
    const result = await this.client.xAutoClaim(stream, group, consumer, minIdleMs, startId, { COUNT: count });
    return {
      nextId: result.nextId,
      entries: result.messages.filter((message) => message !== null).map(toStreamEntry),
      deletedIds: result.deletedMessages,
    };
  }

  async getPending(stream: string, group: string, entryId: string) {
    const [pending] = await this.client.xPendingRange(stream, group, entryId, entryId, 1);
    if (!pending) return undefined;
    return {
      id: pending.id,
      deliveries: pending.deliveriesCounter,
      idleMs: pending.millisecondsSinceLastDelivery,
    };
  }

  async acknowledge(stream: string, group: string, entryId: string): Promise<void> {
    await this.client.xAck(stream, group, entryId);
  }

  async deadLetterAndAcknowledge(
    stream: string,
    group: string,
    entryId: string,
    record: DeadLetterRecord,
  ): Promise<void> {
    const args = [
      group,
      entryId,
      record.sourceStream,
      record.failedAt,
      record.failureCode,
      String(record.attempts),
      String(record.payloadBytes),
      record.payloadSha256,
      record.payload === undefined ? '0' : '1',
      record.payload ?? '',
    ];
    await this.client.eval(deadLetterAndAckScript, {
      keys: [stream, this.deadLetterStream],
      arguments: args,
    });
  }
}

function toStreamEntry(message: { id: string; message: Record<string, string> }): StreamEntry {
  return { id: message.id, fields: message.message };
}
