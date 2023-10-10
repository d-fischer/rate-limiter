import type { RateLimiter, RateLimiterRequestOptions } from '../RateLimiter';
import { TimeBasedRateLimiter, type TimeBasedRateLimiterConfig } from './TimeBasedRateLimiter';

export class TimedPassthruRateLimiter<Req, Res> extends TimeBasedRateLimiter<Req, Res> {
	constructor(child: RateLimiter<Req, Res>, config: Omit<TimeBasedRateLimiterConfig<Req, Res>, 'doRequest'>) {
		super({
			...config,
			async doRequest(req: Req, options?: RateLimiterRequestOptions): Promise<Res> {
				return await child.request(req, options);
			}
		});
	}
}
