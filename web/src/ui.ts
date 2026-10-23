import { createContext, useContext } from 'react';

/** App-wide UI state that is not part of the URL. */
export interface Ui {
  /** Follow mode: keep the newest turn selected and the newest call in view. */
  follow: boolean;
  setFollow(on: boolean): void;
}

export const UiContext = createContext<Ui>({ follow: true, setFollow: () => {} });
export const useUi = () => useContext(UiContext);
