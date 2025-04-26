import { createLogger, type LoggerOptions, type Logger } from '@d-fischer/logger';
import type { QueueEntry } from '../QueueEntry';
import type { RateLimiter, RateLimiterRequestOptions } from '../RateLimiter';
import { RateLimitReachedError } from '../errors/RateLimitReachedError';
import { RateLimiterDestroyedError } from '../errors/RateLimiterDestroyedError';

export interface TimeBasedRateLimiterConfig<Req, Res> {
	bucketSize: number;
	timeFrame: number;
	logger?: Partial<LoggerOptions>;
	doRequest: (req: Req) => Promise<Res>;
}

export class TimeBasedRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	private _queue: Array<QueueEntry<Req, Res>> = [];
	private _usedFromBucket: number = 0;
	private readonly _bucketSize: number;
	private readonly _timeFrame: number;
	private readonly _callback: (req: Req) => Promise<Res>;
	private readonly _counterTimers = new Set<ReturnType<typeof setTimeout>>();

	private _paused = false;
	private _destroyed = false;

	private readonly _logger: Logger;

	constructor({ logger, bucketSize, timeFrame, doRequest }: TimeBasedRateLimiterConfig<Req, Res>) {
		this._logger = createLogger({ name: 'rate-limiter', emoji: true, ...logger });

		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
		this._callback = doRequest;
	}

	async request(req: Req, options?: RateLimiterRequestOptions): Promise<Res> {
		return await new Promise((resolve, reject) => {
			if (this._destroyed) {
				reject(new RateLimiterDestroyedError('Rate limiter was destroyed'));
				return;
			}

			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject,
				limitReachedBehavior: options?.limitReachedBehavior ?? 'enqueue'
			};

			if (this._usedFromBucket >= this._bucketSize || this._paused) {
				switch (reqSpec.limitReachedBehavior) {
					case 'enqueue': {
						this._queue.push(reqSpec);
						if (this._usedFromBucket + this._queue.length >= this._bucketSize) {
							this._logger.warn(
								`Rate limit of ${this._bucketSize} was reached, waiting for ${
									this._paused ? 'the limiter to be unpaused' : 'a free bucket entry'
								}; queue size is ${this._queue.length}`
							);
						} else {
							this._logger.info(
								`Enqueueing request because the rate limiter is paused; queue size is ${this._queue.length}`
							);
						}
						break;
					}
					case 'null': {
						reqSpec.resolve(null!);
						this._logger.warn(
							`Rate limit of ${this._bucketSize} was reached, dropping request and returning null`
						);
						if (this._paused) {
							this._logger.info('Returning null for request because the rate limiter is paused');
						} else {
							this._logger.warn(
								`Rate limit of ${this._bucketSize} was reached, dropping request and returning null`
							);
						}
						break;
					}
					case 'throw': {
						reqSpec.reject(
							new RateLimitReachedError(
								`Request dropped because ${
									this._paused ? 'the rate limiter is paused' : 'the rate limit was reached'
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
				void this._runRequest(reqSpec);
			}
		});
	}

	clear(): void {
		this._queue = [];
	}

	pause(): void {
		this._paused = true;
	}

	resume(): void {
		this._paused = false;
		this._runNextRequest();
	}

	destroy(): void {
		this._paused = false;
		this._destroyed = true;
		this._counterTimers.forEach(timer => {
			clearTimeout(timer);
		});
		for (const req of this._queue) {
			req.reject(new RateLimiterDestroyedError('Rate limiter was destroyed'));
		}
		this._queue = [];
	}

	private async _runRequest(reqSpec: QueueEntry<Req, Res>) {
		this._logger.debug(`doing a request, new queue length is ${this._queue.length}`);
		this._usedFromBucket += 1;
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this._callback(req));
		} catch (e) {
			reject(e as Error);
		} finally {
			const counterTimer = setTimeout(() => {
				this._counterTimers.delete(counterTimer);
				this._usedFromBucket -= 1;
				if (this._queue.length && this._usedFromBucket < this._bucketSize) {
					this._runNextRequest();
				}
			}, this._timeFrame);
			this._counterTimers.add(counterTimer);
		}
	}

	private _runNextRequest() {
		if (this._paused) {
			return;
		}
		const reqSpec = this._queue.shift();
		if (reqSpec) {
			void this._runRequest(reqSpec);
		}
	}
}
