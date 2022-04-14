/**
 * Main OpenSea smart contract address.
 *
 * This contract mostly provides the atomicMatch_ method used when a
 * sale is being made on OpenSea marketplace.
 */
export const WYVERN_EXCHANGE_ADDRESS = '0x7f268357A8c2552623316e2562D90e642bB538E5';

/**
 * Librabry used by OpenSea for bundle sales.
 *
 * This lib, afaik, takes as parameters the different abi encoded
 * calls of "transferFrom" methods of all the NFT contracts involved
 * in the sale.
 */
export const WYVERN_ATOMICIZER_ADDRESS = '0xc99f70bfd82fb7c8f8191fdfbfb735606b15e5c5';

/**
 * Library used by OpenSea for merkle validator.
 */
export const MERKLE_VALIDATOR_ADDRESS = '0xbaf2127b49fc93cbca6269fade0f7f31df4c88a7';
