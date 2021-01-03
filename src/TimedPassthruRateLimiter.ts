import type { TimeBasedRateLimiterConfig } from './TimeBasedRateLimiter';
import { TimeBasedRateLimiter } from './TimeBasedRateLimiter';

export class TimedPassthruRateLimiter<Req, Res> extends TimeBasedRateLimiter<Req, Res> {
	constructor(private readonly _child: TimeBasedRateLimiter<Req, Res>, config: TimeBasedRateLimiterConfig) {
		super(config);
	}

	protected async doRequest(req: Req): Promise<Res> {
		return this._child.request(req);
	}
}
