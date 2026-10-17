import { MongoServerError, type Collection } from 'mongodb';
import type { UsageEvent } from './usage-event.js';
import { toUsageEventDocument, type UsageEventDocument } from './usage-event.js';

export type PersistUsageEventResult = 'inserted' | 'duplicate';

export interface UsageEventStore {
  persistIdempotently(event: UsageEvent): Promise<PersistUsageEventResult>;
}

export class MongoUsageEventStore implements UsageEventStore {
  constructor(private readonly collection: Collection<UsageEventDocument>) {}

  async persistIdempotently(event: UsageEvent): Promise<PersistUsageEventResult> {
    try {
      await this.collection.insertOne(toUsageEventDocument(event));
      return 'inserted';
    } catch (error) {
      if (
        error instanceof MongoServerError &&
        error.code === 11000 &&
        error.keyPattern?._id === 1
      ) {
        return 'duplicate';
      }
      throw error;
    }
  }
}
