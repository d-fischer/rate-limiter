import { Logger } from '@d-fischer/logger';
import type { QueueEntry } from './QueueEntry';
import type { RateLimiter } from './RateLimiter';
import type { TimeBasedRateLimiterConfig } from './TimeBasedRateLimiter';

export interface PartitionedTimeBasedRateLimiterConfig<Req, Res> extends TimeBasedRateLimiterConfig<Req, Res> {
	getPartitionKey: (req: Req) => string;
}

export class PartitionedTimeBasedRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	private readonly _partitionedQueue = new Map<string, Array<QueueEntry<Req, Res>>>();
	private readonly _usedFromBucket = new Map<string, number>();
	private readonly _bucketSize: number;
	private readonly _timeFrame: number;
	private readonly _callback: (req: Req) => Promise<Res>;
	private readonly _partitionKeyCallback: (req: Req) => string;

	private readonly _logger: Logger;

	constructor({
		logger,
		bucketSize,
		timeFrame,
		doRequest,
		getPartitionKey
	}: PartitionedTimeBasedRateLimiterConfig<Req, Res>) {
		this._logger = new Logger({ name: 'rate-limiter', emoji: true, ...logger });

		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
		this._callback = doRequest;
		this._partitionKeyCallback = getPartitionKey;
	}

	async request(req: Req): Promise<Res> {
		return new Promise((resolve, reject) => {
			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject
			};

			const partitionKey = this._partitionKeyCallback(req);
			const usedFromBucket = this._usedFromBucket.get(partitionKey) ?? 0;
			if (usedFromBucket >= this._bucketSize) {
				const queue = this._getPartitionedQueue(partitionKey);
				queue.push(reqSpec);
				this._logger.warn(
					`Rate limit of ${this._bucketSize} for partition ${partitionKey} was reached, waiting for a free bucket entry; queue size is ${queue.length}`
				);
			} else {
				void this._runRequest(reqSpec, partitionKey);
			}
		});
	}

	private _getPartitionedQueue(partitionKey: string): Array<QueueEntry<Req, Res>> {
		if (this._partitionedQueue.has(partitionKey)) {
			return this._partitionedQueue.get(partitionKey)!;
		}

		const newQueue: Array<QueueEntry<Req, Res>> = [];
		this._partitionedQueue.set(partitionKey, newQueue);
		return newQueue;
	}

	private async _runRequest(reqSpec: QueueEntry<Req, Res>, partitionKey: string) {
		const queue = this._getPartitionedQueue(partitionKey);
		this._logger.debug(`doing a request for partiton ${partitionKey}, new queue length is ${queue.length}`);
		this._usedFromBucket.set(partitionKey, (this._usedFromBucket.get(partitionKey) ?? 0) + 1);
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this._callback(req));
		} catch (e) {
			reject(e);
		} finally {
			setTimeout(() => {
				const newUsed = this._usedFromBucket.get(partitionKey)! - 1;
				this._usedFromBucket.set(partitionKey, newUsed);
				if (queue.length && newUsed < this._bucketSize) {
					this._runNextRequest(partitionKey);
				}
			}, this._timeFrame);
		}
	}

	private _runNextRequest(partitionKey: string) {
		const queue = this._getPartitionedQueue(partitionKey);
		const reqSpec = queue.shift();
		if (reqSpec) {
			void this._runRequest(reqSpec, partitionKey);
		}
	}
}
