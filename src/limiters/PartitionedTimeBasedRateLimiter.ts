import type { Logger } from '@d-fischer/logger';
import { createLogger } from '@d-fischer/logger';
import type { QueueEntry } from '../QueueEntry';
import type { RateLimiter, RateLimiterRequestOptions } from '../RateLimiter';
import { RateLimitReachedError } from '../errors/RateLimitReachedError';
import type { TimeBasedRateLimiterConfig } from './TimeBasedRateLimiter';

export interface PartitionedTimeBasedRateLimiterConfig<Req, Res> extends TimeBasedRateLimiterConfig<Req, Res> {
	getPartitionKey: (req: Req) => string | null;
}

export class PartitionedTimeBasedRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	private readonly _partitionedQueue = new Map<string | null, Array<QueueEntry<Req, Res>>>();
	private readonly _usedFromBucket = new Map<string | null, number>();
	private readonly _bucketSize: number;
	private readonly _timeFrame: number;
	private readonly _callback: (req: Req) => Promise<Res>;
	private readonly _partitionKeyCallback: (req: Req) => string | null;

	private _paused = false;

	private readonly _logger: Logger;

	constructor({
		logger,
		bucketSize,
		timeFrame,
		doRequest,
		getPartitionKey
	}: PartitionedTimeBasedRateLimiterConfig<Req, Res>) {
		this._logger = createLogger({ name: 'rate-limiter', emoji: true, ...logger });

		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
		this._callback = doRequest;
		this._partitionKeyCallback = getPartitionKey;
	}

	async request(req: Req, options?: RateLimiterRequestOptions): Promise<Res> {
		return await new Promise((resolve, reject) => {
			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject,
				limitReachedBehavior: options?.limitReachedBehavior ?? 'enqueue'
			};

			const partitionKey = this._partitionKeyCallback(req);
			const usedFromBucket = this._usedFromBucket.get(partitionKey) ?? 0;
			if (usedFromBucket >= this._bucketSize || this._paused) {
				switch (reqSpec.limitReachedBehavior) {
					case 'enqueue': {
						const queue = this._getPartitionedQueue(partitionKey);
						queue.push(reqSpec);
						if (usedFromBucket + queue.length >= this._bucketSize) {
							this._logger.warn(
								`Rate limit of ${this._bucketSize} for ${
									partitionKey ? `partition ${partitionKey}` : 'default partition'
								} was reached, waiting for ${
									this._paused ? 'the limiter to be unpaused' : 'a free bucket entry'
								}; queue size is ${queue.length}`
							);
						} else {
							this._logger.info(
								`Enqueueing request for ${
									partitionKey ? `partition ${partitionKey}` : 'default partition'
								} because the rate limiter is paused; queue size is ${queue.length}`
							);
						}
						break;
					}
					case 'null': {
						reqSpec.resolve(null!);
						if (this._paused) {
							this._logger.info(
								`Returning null for request for ${
									partitionKey ? `partition ${partitionKey}` : 'default partition'
								} because the rate limiter is paused`
							);
						} else {
							this._logger.warn(
								`Rate limit of ${this._bucketSize} for ${
									partitionKey ? `partition ${partitionKey}` : 'default partition'
								} was reached, dropping request and returning null`
							);
						}
						break;
					}
					case 'throw': {
						reqSpec.reject(
							new RateLimitReachedError(
								`Request dropped because ${
									this._paused
										? 'the rate limiter is paused'
										: `the rate limit for ${
												partitionKey ? `partition ${partitionKey}` : 'default partition'
										  } was reached`
								}`
							)
						);
						break;
					}
					default: {
						throw new Error('this should never happen');
					}
				}
			} else {
				void this._runRequest(reqSpec, partitionKey);
			}
		});
	}

	clear(): void {
		this._partitionedQueue.clear();
	}

	pause(): void {
		this._paused = true;
	}

	resume(): void {
		this._paused = false;
		for (const partitionKey of this._partitionedQueue.keys()) {
			this._runNextRequest(partitionKey);
		}
	}

	private _getPartitionedQueue(partitionKey: string | null): Array<QueueEntry<Req, Res>> {
		if (this._partitionedQueue.has(partitionKey)) {
			return this._partitionedQueue.get(partitionKey)!;
		}

		const newQueue: Array<QueueEntry<Req, Res>> = [];
		this._partitionedQueue.set(partitionKey, newQueue);
		return newQueue;
	}

	private async _runRequest(reqSpec: QueueEntry<Req, Res>, partitionKey: string | null) {
		const queue = this._getPartitionedQueue(partitionKey);
		this._logger.debug(
			`doing a request for ${
				partitionKey ? `partition ${partitionKey}` : 'default partition'
			}, new queue length is ${queue.length}`
		);
		this._usedFromBucket.set(partitionKey, (this._usedFromBucket.get(partitionKey) ?? 0) + 1);
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this._callback(req));
		} catch (e) {
			reject(e as Error);
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

	private _runNextRequest(partitionKey: string | null) {
		if (this._paused) {
			return;
		}
		const queue = this._getPartitionedQueue(partitionKey);
		const reqSpec = queue.shift();
		if (reqSpec) {
			void this._runRequest(reqSpec, partitionKey);
		}
	}
}
