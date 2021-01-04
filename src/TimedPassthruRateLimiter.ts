import type { RateLimiter } from './RateLimiter';
import type { TimeBasedRateLimiterConfig } from './TimeBasedRateLimiter';
import { TimeBasedRateLimiter } from './TimeBasedRateLimiter';

export class TimedPassthruRateLimiter<Req, Res> extends TimeBasedRateLimiter<Req, Res> {
	constructor(private readonly _child: RateLimiter<Req, Res>, config: TimeBasedRateLimiterConfig<Req, Res>) {
		super(config);
	}

	protected async doRequest(req: Req): Promise<Res> {
		return this._child.request(req);
	}
}
