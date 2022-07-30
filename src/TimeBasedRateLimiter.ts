import type { LoggerOptions, Logger } from '@d-fischer/logger';
import { createLogger } from '@d-fischer/logger';
import type { QueueEntry } from './QueueEntry';
import type { RateLimiter, RateLimiterRequestOptions } from './RateLimiter';
import { RateLimitReachedError } from './RateLimitReachedError';

export interface TimeBasedRateLimiterConfig<Req, Res> {
	bucketSize: number;
	timeFrame: number;
	logger?: Partial<LoggerOptions>;
	doRequest: (req: Req) => Promise<Res>;
}

export class TimeBasedRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	private readonly _queue: Array<QueueEntry<Req, Res>> = [];
	private _usedFromBucket: number = 0;
	private readonly _bucketSize: number;
	private readonly _timeFrame: number;
	private readonly _callback: (req: Req) => Promise<Res>;

	private readonly _logger: Logger;

	constructor({ logger, bucketSize, timeFrame, doRequest }: TimeBasedRateLimiterConfig<Req, Res>) {
		this._logger = createLogger({ name: 'rate-limiter', emoji: true, ...logger });

		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
		this._callback = doRequest;
	}

	async request(req: Req, options?: RateLimiterRequestOptions): Promise<Res> {
		return new Promise((resolve, reject) => {
			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject,
				limitReachedBehavior: options?.limitReachedBehavior ?? 'enqueue'
			};

			if (this._usedFromBucket >= this._bucketSize) {
				switch (reqSpec.limitReachedBehavior) {
					case 'enqueue': {
						this._queue.push(reqSpec);
						this._logger.warn(
							`Rate limit of ${this._bucketSize} was reached, waiting for a free bucket entry; queue size is ${this._queue.length}`
						);
						break;
					}
					case 'null': {
						reqSpec.resolve(null!);
						this._logger.warn(
							`Rate limit of ${this._bucketSize} was reached, dropping request and returning null`
						);
						break;
					}
					case 'throw': {
						reqSpec.reject(new RateLimitReachedError('Request dropped because the rate limit was reached'));
						break;
					}
					default: {
						throw new Error('this should never happen');
					}
				}
			} else {
				void this._runRequest(reqSpec);
			}
		});
	}

	private async _runRequest(reqSpec: QueueEntry<Req, Res>) {
		this._logger.debug(`doing a request, new queue length is ${this._queue.length}`);
		this._usedFromBucket += 1;
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this._callback(req));
		} catch (e) {
			reject(e);
		} finally {
			setTimeout(() => {
				this._usedFromBucket -= 1;
				if (this._queue.length && this._usedFromBucket < this._bucketSize) {
					this._runNextRequest();
				}
			}, this._timeFrame);
		}
	}

	private _runNextRequest() {
		const reqSpec = this._queue.shift();
		if (reqSpec) {
			void this._runRequest(reqSpec);
		}
	}
}
