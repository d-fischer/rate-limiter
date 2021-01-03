import { Logger } from '@d-fischer/logger';
import type { LoggerOptions } from '@d-fischer/logger';
import type { QueueEntry } from './QueueEntry';

export interface TimeBasedRateLimiterConfig {
	bucketSize: number;
	timeFrame: number;
	logger?: LoggerOptions;
}

export abstract class TimeBasedRateLimiter<Req, Res> {
	private readonly _queue: Array<QueueEntry<Req, Res>> = [];
	private _usedFromBucket: number = 0;
	private readonly _bucketSize: number;
	private readonly _timeFrame: number;

	private readonly _logger;

	constructor({ logger, bucketSize, timeFrame }: TimeBasedRateLimiterConfig) {
		this._logger = new Logger({ name: 'rate-limiter', emoji: true, ...logger });

		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
	}

	async request(req: Req): Promise<Res> {
		return new Promise((resolve, reject) => {
			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject
			};

			if (this._usedFromBucket >= this._bucketSize) {
				this._queue.push(reqSpec);
				this._logger.warn(
					`Rate limit of ${this._bucketSize} was reached, waiting for a free bucket entry; queue size is ${this._queue.length}`
				);
			} else {
				void this._runRequest(reqSpec);
			}
		});
	}

	protected abstract doRequest(req: Req): Promise<Res>;

	private async _runRequest(reqSpec: QueueEntry<Req, Res>) {
		this._logger.debug(`doing a request, new queue length is ${this._queue.length}`);
		this._usedFromBucket += 1;
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this.doRequest(req));
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
