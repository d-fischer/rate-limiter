import type { RateLimiter } from './RateLimiter';
import type { TimeBasedRateLimiterConfig } from './TimeBasedRateLimiter';
import { TimeBasedRateLimiter } from './TimeBasedRateLimiter';

export class TimedPassthruRateLimiter<Req, Res> extends TimeBasedRateLimiter<Req, Res> {
	constructor(child: RateLimiter<Req, Res>, config: Omit<TimeBasedRateLimiterConfig<Req, Res>, 'doRequest'>) {
		super({
			...config,
			async doRequest(req: Req): Promise<Res> {
				return child.request(req);
			}
		});
	}
}
