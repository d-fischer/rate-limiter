import type { RateLimiter } from './RateLimiter';

export class NullRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	constructor(private readonly _callback: (req: Req) => Promise<Res>) {}

	async request(req: Req): Promise<Res> {
		return this._callback(req);
	}
}
