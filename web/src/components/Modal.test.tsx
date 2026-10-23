import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { Modal } from './Modal';

function renderModal(onClose = vi.fn()) {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <button type="button">outside</button>
      <Modal label="Inspect" onClose={onClose}>
        <button type="button">first inside</button>
        <input aria-label="field" />
      </Modal>
    </I18nContext.Provider>,
  );
  return onClose;
}

describe('Modal focus', () => {
  it('keeps Tab and Shift+Tab inside the dialog', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Inspect' });
    const close = screen.getByRole('button', { name: 'Close' });
    const field = screen.getByRole('textbox', { name: 'field' });
    expect(close).toHaveFocus();
    field.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(field).toHaveFocus();
  });

  it('closes on Escape', () => {
    const onClose = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
