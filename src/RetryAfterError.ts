import CustomError from './CustomError';

export default class RetryAfterError extends CustomError {
	private readonly _retryAt: number;

	constructor(after: number) {
		super(`Need to retry after ${after} ms`);
		this._retryAt = Date.now() + after;
	}

	get retryAt() {
		return this._retryAt;
	}
}
