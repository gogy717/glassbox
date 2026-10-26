/** The API price table in force: the defaults, with the person's own prices from Settings. */
import { createContext, useContext } from 'react';
import { DEFAULT_PRICES, type PriceTable } from '../lib/prices';

export const PriceTableContext = createContext<PriceTable>(DEFAULT_PRICES);

export const usePriceTable = () => useContext(PriceTableContext);
