import { type RateLimiter, type RateLimiterRequestOptions } from '../RateLimiter';
import { type RateLimiterStats } from '../RateLimiterStats';
import { ResponseBasedRateLimiter } from './ResponseBasedRateLimiter';

export interface PartitionedRateLimiterOptions<Req, Res> {
	getPartitionKey: (req: Req) => string | null;
	createChild: (partitionKey: string | null) => RateLimiter<Req, Res>;
}

export class PartitionedRateLimiter<Req, Res> implements RateLimiter<Req, Res> {
	private readonly _children = new Map<string | null, RateLimiter<Req, Res>>();
	private readonly _partitionKeyCallback: (req: Req) => string | null;
	private readonly _createChildCallback: (partitionKey: string | null) => RateLimiter<Req, Res>;

	constructor(options: PartitionedRateLimiterOptions<Req, Res>) {
		this._partitionKeyCallback = options.getPartitionKey;
		this._createChildCallback = options.createChild;
	}

	async request(req: Req, options?: RateLimiterRequestOptions): Promise<Res> {
		const partitionKey = this._partitionKeyCallback(req);
		const partitionChild = this._getChild(partitionKey);

		return await partitionChild.request(req, options);
	}

	getChildStats(partitionKey: string | null): RateLimiterStats | null {
		if (!this._children.has(partitionKey)) {
			return null;
		}

		const child = this._children.get(partitionKey)!;

		if (!(child instanceof ResponseBasedRateLimiter)) {
			return null;
		}

		return child.stats;
	}

	private _getChild(partitionKey: string | null): RateLimiter<Req, Res> {
		if (this._children.has(partitionKey)) {
			return this._children.get(partitionKey)!;
		}

		const result = this._createChildCallback(partitionKey);
		this._children.set(partitionKey, result);
		return result;
	}
}
