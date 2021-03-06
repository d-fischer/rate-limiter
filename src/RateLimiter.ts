export interface RateLimiter<Req, Res> {
	request: (req: Req) => Promise<Res>;
}
