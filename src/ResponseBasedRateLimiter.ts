import Logger, { LogLevel } from '@d-fischer/logger';
import { rebindable as allSettled, PromiseRejection, PromiseResolution } from '@d-fischer/promise.allsettled';
import RetryAfterError from './RetryAfterError';

export interface RateLimiterResponseParameters {
	limit: number;
	remaining: number;
	resetsAt: number;
}

interface QueueEntry<Req, Res, Err = Error> {
	req: Req;
	resolve: (res?: Res | PromiseLike<Res>) => void;
	reject: (err: Err) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default abstract class ResponseBasedRateLimiter<Req, Res = any> {
	private _parameters?: RateLimiterResponseParameters;
	private _queue: Array<QueueEntry<Req, Res>> = [];
	private _batchRunning = false;
	private _nextBatchTimer?: NodeJS.Timer;

	private _logger: Logger;

	constructor(logLevel: LogLevel) {
		this._logger = new Logger({ name: 'rate-limiter', minLevel: logLevel, emoji: true });
	}

	async request(req: Req): Promise<Res> {
		return new Promise<Res>((resolve, reject) => {
			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject
			};

			if (this._batchRunning || this._nextBatchTimer) {
				this._queue.push(reqSpec);
			} else {
				this._runRequestBatch([reqSpec]);
			}
		});
	}

	protected abstract doRequest(req: Req): Promise<Res>;

	protected abstract needsToRetryAfter(res: Res): number | null;

	protected abstract getParametersFromResponse(res: Res): RateLimiterResponseParameters;

	private async _runRequestBatch(reqSpecs: Array<QueueEntry<Req, Res>>) {
		this._batchRunning = true;
		if (this._parameters) {
			this._logger.debug1(`remaining requests: ${this._parameters.remaining}`);
		}
		this._logger.debug2(`doing ${reqSpecs.length} requests, new queue length is ${this._queue.length}`);
		const promises = reqSpecs.map(
			async (reqSpec): Promise<RateLimiterResponseParameters | undefined> => {
				const { req, resolve, reject } = reqSpec;

				try {
					const result = await this.doRequest(req);
					const retry = this.needsToRetryAfter(result);
					if (retry !== null) {
						this._queue.unshift(reqSpec);
						this._logger.info(`Retrying after ${retry} ms`);
						throw new RetryAfterError(retry);
					}
					const params = this.getParametersFromResponse(result);
					resolve(result);
					return params;
				} catch (e) {
					if (e instanceof RetryAfterError) {
						throw e;
					}
					reject(e);
					return undefined;
				}
			}
		);

		const settledPromises = await allSettled(promises);
		const rejectedPromises = settledPromises.filter(p => p.status === 'rejected');

		const now = Date.now();
		if (rejectedPromises.length) {
			const retryAt = Math.max(
				now,
				...rejectedPromises.map((p: PromiseRejection<RetryAfterError>) => p.reason.retryAt)
			);
			const retryAfter = retryAt - now;
			this._logger.warn(`waiting for ${retryAfter} ms because the rate limit was exceeded`);
			this._nextBatchTimer = setTimeout(() => {
				this._parameters = undefined;
				this._runNextBatch();
			}, retryAfter);
		} else {
			const params = settledPromises
				.map((p: PromiseResolution<RateLimiterResponseParameters | undefined>) => p.value)
				.filter((v): v is RateLimiterResponseParameters => v !== undefined)
				.reduce<RateLimiterResponseParameters | undefined>((carry, v) => {
					if (!carry) {
						return v;
					}

					// return v.resetsAt > carry.resetsAt ? v : carry;
					return v.remaining < carry.remaining ? v : carry;
				}, undefined);

			this._batchRunning = false;
			if (params) {
				this._parameters = params;
				if (params.resetsAt < now || params.remaining > 0) {
					this._runNextBatch();
				} else {
					const delay = params.resetsAt - now;
					this._logger.warn(`Waiting for ${delay} ms because the rate limit was reached`);
					this._nextBatchTimer = setTimeout(() => {
						this._parameters = undefined;
						this._runNextBatch();
					}, delay);
				}
			}
		}
	}

	private async _runNextBatch() {
		if (this._nextBatchTimer) {
			clearTimeout(this._nextBatchTimer);
			this._nextBatchTimer = undefined;
		}
		const amount = this._parameters ? Math.min(this._parameters.remaining, this._parameters.limit / 10) : 1;
		const reqSpecs = this._queue.splice(0, amount);
		if (reqSpecs.length) {
			this._runRequestBatch(reqSpecs);
		}
	}
}
