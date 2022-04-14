import { Stats } from '@johnkcr/temple-lib/dist/types/core';

export type PreAggregationStats = Pick<
  Stats,
  | 'avgPrice'
  | 'ceilPrice'
  | 'chainId'
  | 'collectionAddress'
  | 'floorPrice'
  | 'numSales'
  | 'tokenId'
  | 'volume'
  | 'updatedAt'
>;
