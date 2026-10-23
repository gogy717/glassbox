import { Component, type ReactNode } from 'react';
import { I18nContext } from '../i18n';

interface State {
  error: Error | null;
}

/**
 * Keeps one broken view from blanking the whole app (React unmounts the root on an uncaught
 * render error). "Try again" re-renders the children.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  static override contextType = I18nContext;
  declare context: React.ContextType<typeof I18nContext>;
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { t } = this.context;
    return (
      <div role="alert" style={{ margin: '18vh auto 0', maxWidth: 480, textAlign: 'center' }}>
        <p>{t('error.view', { msg: error.message })}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          {t('error.retry')}
        </button>
      </div>
    );
  }
}
