export interface QueueEntry<Req, Res, Err = Error> {
	req: Req;
	resolve: (res: Res | PromiseLike<Res>) => void;
	reject: (err: Err) => void;
}
