import type { Logger, LoggerOptions } from '@d-fischer/logger';
import { createLogger } from '@d-fischer/logger';
import type { PromiseRejection, PromiseResolution } from '@d-fischer/promise.allsettled';
import allSettled from '@d-fischer/promise.allsettled';
import { mapNullable } from '@d-fischer/shared-utils';
import type { QueueEntry } from './QueueEntry';
import type { RateLimiter } from './RateLimiter';
import { RetryAfterError } from './RetryAfterError';

export interface RateLimiterResponseParameters {
	limit: number;
	remaining: number;
	resetsAt: number;
}

export interface ResponseBasedRateLimiterConfig {
	logger?: Partial<LoggerOptions>;
}

export abstract class ResponseBasedRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	private _parameters?: RateLimiterResponseParameters;
	private readonly _queue: Array<QueueEntry<Req, Res>> = [];
	private _batchRunning = false;
	private _nextBatchTimer?: NodeJS.Timer;

	private readonly _logger: Logger;

	constructor({ logger }: ResponseBasedRateLimiterConfig) {
		this._logger = createLogger({ name: 'rate-limiter', emoji: true, ...logger });
	}

	async request(req: Req): Promise<Res> {
		this._logger.trace('request start');
		return new Promise<Res>((resolve, reject) => {
			const reqSpec: QueueEntry<Req, Res> = {
				req,
				resolve,
				reject
			};

			if (this._batchRunning || this._nextBatchTimer) {
				this._logger.trace(
					`request queued batchRunning:${this._batchRunning.toString()} hasNextBatchTimer:${(!!this
						._nextBatchTimer).toString()}`
				);
				this._queue.push(reqSpec);
			} else {
				void this._runRequestBatch([reqSpec]);
			}
		});
	}

	get lastKnownLimit(): number | null {
		return this._parameters?.limit ?? null;
	}

	get lastKnownRemainingRequests(): number | null {
		return this._parameters?.remaining ?? null;
	}

	get lastKnownResetDate(): Date | null {
		return mapNullable(this._parameters?.resetsAt, v => new Date(v));
	}

	protected abstract doRequest(req: Req): Promise<Res>;

	protected abstract needsToRetryAfter(res: Res): number | null;

	protected abstract getParametersFromResponse(res: Res): RateLimiterResponseParameters;

	private async _runRequestBatch(reqSpecs: Array<QueueEntry<Req, Res>>) {
		this._logger.trace(`runRequestBatch start specs:${reqSpecs.length}`);
		this._batchRunning = true;
		if (this._parameters) {
			this._logger.debug(`Remaining requests: ${this._parameters.remaining}`);
		}
		this._logger.debug(`Doing ${reqSpecs.length} requests, new queue length is ${this._queue.length}`);
		const promises = reqSpecs.map(async (reqSpec): Promise<RateLimiterResponseParameters | undefined> => {
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
		});

		// downleveling problem hack, see https://github.com/es-shims/Promise.allSettled/issues/5
		const settledPromises = await allSettled.call(Promise, promises);
		const rejectedPromises = settledPromises.filter(
			(p): p is PromiseRejection<RetryAfterError> => p.status === 'rejected'
		);

		const now = Date.now();
		if (rejectedPromises.length) {
			this._logger.trace('runRequestBatch some rejected');
			const retryAt = Math.max(
				now,
				...rejectedPromises.map((p: PromiseRejection<RetryAfterError>) => p.reason.retryAt)
			);
			const retryAfter = retryAt - now;
			this._logger.warn(`Waiting for ${retryAfter} ms because the rate limit was exceeded`);
			this._nextBatchTimer = setTimeout(() => {
				this._parameters = undefined;
				void this._runNextBatch();
			}, retryAfter);
		} else {
			this._logger.trace('runRequestBatch none rejected');
			const params = settledPromises
				.filter(
					(p): p is PromiseResolution<RateLimiterResponseParameters> =>
						p.status === 'fulfilled' && p.value !== undefined
				)
				.map(p => p.value)
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
					this._logger.trace('runRequestBatch canRunMore');
					void this._runNextBatch();
				} else {
					const delay = params.resetsAt - now;
					this._logger.trace(`runRequestBatch delay:${delay}`);
					this._logger.warn(`Waiting for ${delay} ms because the rate limit was reached`);
					this._nextBatchTimer = setTimeout(() => {
						this._parameters = undefined;
						void this._runNextBatch();
					}, delay);
				}
			} else {
				void this._runNextBatch();
			}
		}
		this._logger.trace('runRequestBatch end');
	}

	private async _runNextBatch() {
		this._logger.trace('runNextBatch start');
		if (this._nextBatchTimer) {
			clearTimeout(this._nextBatchTimer);
			this._nextBatchTimer = undefined;
		}
		const amount = this._parameters ? Math.min(this._parameters.remaining, this._parameters.limit / 10) : 1;
		const reqSpecs = this._queue.splice(0, amount);
		if (reqSpecs.length) {
			void this._runRequestBatch(reqSpecs);
		}
		this._logger.trace('runNextBatch end');
	}
}
