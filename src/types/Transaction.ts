import { NftSale } from '@johnkcr/temple-lib/dist/types/core/NftSale';

/**
 * represents an ethereum transaction containing sales of one or more nfts
 */
export type TransactionType = { sales: NftSale[]; totalPrice: number };
