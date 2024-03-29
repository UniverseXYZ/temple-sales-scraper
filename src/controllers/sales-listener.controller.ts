import { ethers } from 'ethers';
import { Block } from '@ethersproject/abstract-provider';
import { WYVERN_EXCHANGE_ADDRESS, MERKLE_VALIDATOR_ADDRESS, WYVERN_ATOMICIZER_ADDRESS } from '../constants';
import WyvernExchangeABI from '../abi/wyvernExchange.json';
import Providers from '../models/Providers';
import { PreParsedNftSale } from '../types/index';
import { logger } from '../container';
import { sleep } from '@johnkcr/temple-lib/dist/utils';
import { parseSaleOrders } from './sales-parser.controller';
import DebouncedSalesUpdater from 'models/DebouncedSalesUpdater';
import { SaleSource, TokenStandard } from '@johnkcr/temple-lib/dist/types/core';

const ETH_CHAIN_ID = '1';
const providers = new Providers();
const ethProvider = providers.getProviderByChainId(ETH_CHAIN_ID);

type DecodedAtomicMatchInputs = {
  calldataBuy: string;
  addrs: string[];
  uints: BigInt[];
};

interface TokenInfo {
  collectionAddr: string;
  tokenIdStr: string;
  quantity: number;
  tokenType: string;
}

/**
 *
 * @param inputs inputs AtomicMatch call that triggered the handleAtomicMatch_ call handler.
 * @description This function is used to handle the case of a "bundle" sale made from OpenSea.
 *              A "bundle" sale is a sale that contains several assets embedded in the same, atomic, transaction.
 */
function handleBundleSale(inputs: DecodedAtomicMatchInputs): TokenInfo[] {
  const calldataBuy: string = inputs?.calldataBuy;
  const TRAILING_OX = 2;
  const METHOD_ID_LENGTH = 8;
  const UINT_256_LENGTH = 64;

  const indexStartNbToken = TRAILING_OX + METHOD_ID_LENGTH + UINT_256_LENGTH * 4;
  const indexStopNbToken = indexStartNbToken + UINT_256_LENGTH;

  const nbToken = ethers.BigNumber.from('0x' + calldataBuy.slice(indexStartNbToken, indexStopNbToken)).toNumber();
  const collectionAddrs: string[] = [];
  let offset = indexStopNbToken;
  for (let i = 0; i < nbToken; i++) {
    collectionAddrs.push(
      ethers.BigNumber.from('0x' + calldataBuy.slice(offset, offset + UINT_256_LENGTH)).toHexString()
    );

    // Move forward in the call data
    offset += UINT_256_LENGTH;
  }

  /**
   * After reading the contract addresses involved in the bundle sale
   * there are 2 chunks of params of length nbToken * UINT_256_LENGTH.
   *
   * Those chunks are each preceded by a "chunk metadata" of length UINT_256_LENGTH
   * Finally a last "chunk metadata" is set of length UINT_256_LENGTH. (3 META_CHUNKS)
   *
   *
   * After that we are reading the abi encoded data representing the transferFrom calls
   */
  const LEFT_CHUNKS = 2;
  const NB_META_CHUNKS = 3;
  offset += nbToken * UINT_256_LENGTH * LEFT_CHUNKS + NB_META_CHUNKS * UINT_256_LENGTH;

  const TRANSFER_FROM_DATA_LENGTH = METHOD_ID_LENGTH + UINT_256_LENGTH * 3;
  const tokenIdsList: string[] = [];
  for (let i = 0; i < nbToken; i++) {
    const transferFromData = calldataBuy.substring(offset, offset + TRANSFER_FROM_DATA_LENGTH);
    const tokenIdstr = ethers.BigNumber.from(
      '0x' + transferFromData.substring(METHOD_ID_LENGTH + UINT_256_LENGTH * 2)
    ).toString();
    tokenIdsList.push(tokenIdstr);

    // Move forward in the call data
    offset += TRANSFER_FROM_DATA_LENGTH;
  }

  return collectionAddrs.map((val, index) => ({
    collectionAddr: collectionAddrs[index],
    tokenIdStr: tokenIdsList[index],
    quantity: 1,
    tokenType: TokenStandard.ERC721
  }));
}

/**
 *
 * @param inputs The AtomicMatch call that triggered the handleAtomicMatch_ call handler.
 * @description This function is used to handle the case of a "normal" sale made from OpenSea.
 *              A "normal" sale is a sale that is not a bundle (only contains one asset).
 */

function handleSingleSale(inputs: DecodedAtomicMatchInputs): TokenInfo {
  const TRAILING_OX = 2;
  const METHOD_ID_LENGTH = 8;
  const UINT_256_LENGTH = 64;

  const addrs = inputs.addrs;
  const nftAddrs: string = addrs[4];

  let collectionAddr;
  let tokenIdStr;
  let quantity = 1;
  let tokenType = TokenStandard.ERC721;
  const calldataBuy: string = inputs.calldataBuy;

  let offset = TRAILING_OX + METHOD_ID_LENGTH + UINT_256_LENGTH * 2;
  if (nftAddrs.toLowerCase() === MERKLE_VALIDATOR_ADDRESS) {
    collectionAddr = ethers.BigNumber.from('0x' + calldataBuy.slice(offset, offset + UINT_256_LENGTH)).toHexString();
    offset += UINT_256_LENGTH;
    tokenIdStr = ethers.BigNumber.from('0x' + calldataBuy.slice(offset, offset + UINT_256_LENGTH)).toString();
    offset += UINT_256_LENGTH;
    if (calldataBuy.length > 458) {
      quantity = ethers.BigNumber.from('0x' + calldataBuy.slice(offset, offset + UINT_256_LENGTH)).toNumber();
      tokenType = TokenStandard.ERC1155;
    }
  } else {
    // Token minted on Opensea
    collectionAddr = nftAddrs.toLowerCase();
    tokenIdStr = ethers.BigNumber.from('0x' + calldataBuy.slice(offset, offset + UINT_256_LENGTH)).toString();
    offset += UINT_256_LENGTH;
    if (calldataBuy.length > 202) {
      quantity = ethers.BigNumber.from('0x' + calldataBuy.slice(offset, offset + UINT_256_LENGTH)).toNumber();
      tokenType = TokenStandard.ERC1155;
    }
  }

  return {
    collectionAddr,
    tokenIdStr,
    quantity,
    tokenType
  };
}

/**
 *
 * @param call The AtomicMatch call that triggered this call handler.
 * @description When a sale is made on OpenSea an AtomicMatch_ call is invoked.
 *              This handler will create the associated OpenSeaSale entity
 */
function handleAtomicMatch_(
  inputs: DecodedAtomicMatchInputs,
  txHash: string,
  block: Block
): PreParsedNftSale[] | undefined {
  try {
    logger.log({ inputs });
    const addrs: string[] = inputs.addrs;
    const saleAddress: string = addrs[11];

    const uints: BigInt[] = inputs.uints;
    const price: BigInt = uints[4];
    const buyer = addrs[1]; // Buyer.maker
    const seller = addrs[8]; // Seller.maker
    const paymentTokenErc20Address = addrs[6];

    const res: PreParsedNftSale = {
      chainId: ETH_CHAIN_ID,
      txHash,
      blockNumber: block.number,
      timestamp: block.timestamp * 1000,
      price,
      paymentToken: paymentTokenErc20Address,
      buyer,
      seller,
      collectionAddress: '',
      tokenId: '',
      quantity: 0,
      source: SaleSource.OpenSea,
      tokenStandard: TokenStandard.ERC721
    };

    if (saleAddress.toLowerCase() !== WYVERN_ATOMICIZER_ADDRESS) {
      const token = handleSingleSale(inputs);
      res.collectionAddress = token.collectionAddr;
      res.tokenId = token.tokenIdStr;
      res.tokenStandard = token.tokenType === TokenStandard.ERC721 ? TokenStandard.ERC721 : TokenStandard.ERC1155;
      res.quantity = token.quantity;
      return [res];
    } else {
      const tokens = handleBundleSale(inputs);
      const response: PreParsedNftSale[] = tokens.map((token: TokenInfo) => {
        res.collectionAddress = token.collectionAddr;
        res.tokenId = token.tokenIdStr;
        res.tokenStandard = TokenStandard.ERC721;
        res.quantity = token.quantity;
        return res;
      });
      return response;
    }
  } catch (err) {
    logger.error(`Failed to parse open sales transaction: ${txHash}`);
  }
}

const getTransactionByHash = async (txHash: string): Promise<ethers.utils.BytesLike> => {
  return (await ethProvider.getTransaction(txHash)).data;
};

const execute = (): void => {
  /*
    --- Listen Opensea Sales event
  */
  const OpenseaContract = new ethers.Contract(WYVERN_EXCHANGE_ADDRESS, WyvernExchangeABI, ethProvider);
  const openseaIface = new ethers.utils.Interface(WyvernExchangeABI);
  const salesUpdater = new DebouncedSalesUpdater();

  OpenseaContract.on('OrdersMatched', async (...args: ethers.Event[]) => {
    if (!args?.length || !Array.isArray(args) || !args[args.length - 1]) {
      return;
    }
    const event: ethers.Event = args[args.length - 1];
    const txHash: string = event?.transactionHash;
    if (!txHash) {
      return;
    }

    let response;
    let maxAttempts = 10;
    while (maxAttempts > 0) {
      try {
        response = await getTransactionByHash(txHash);
      } catch (err) {
        await sleep(2000);
        maxAttempts--;
        continue;
      }
      break;
    }

    logger.log({ response });
    try {
      const block: Block = await event.getBlock();
      const decodedResponse: DecodedAtomicMatchInputs = openseaIface.decodeFunctionData(
        'atomicMatch_',
        response as ethers.utils.BytesLike
      ) as any;

      logger.log({ decodedResponse });
      const saleOrders = handleAtomicMatch_(decodedResponse, txHash, block);
      // if (Array.isArray(saleOrders) && saleOrders?.length > 0) {
      //   logger.log(`Listener:[Opensea] fetched new order successfully: ${txHash}`);
      //   const { sales, totalPrice } = parseSaleOrders(saleOrders);

      //   await salesUpdater.saveTransaction({ sales, totalPrice });
      // }
    } catch (err) {
      logger.error(`Listener:[Opensea] failed to fetch new order: ${txHash}`);
    }
  });
};

export { execute };
