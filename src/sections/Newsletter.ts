/**
 * The newsletter form.
 *
 * There is no backend and there never will be — the footer says as much. What
 * matters is that the form does not do the one thing an unhandled form does,
 * which is reload the page and lose the reader's scroll position the moment
 * they press Enter in the field.
 *
 * Nothing is sent anywhere. The address is not stored, not read, and not put
 * on the wire; submitting replaces the field with a confirmation and that is
 * the whole transaction.
 */
const STATUS_CLASS = 'site-footer__status';
const CONFIRMATION = 'Recorded. There will be no releases.';

export class Newsletter {
  private readonly form: HTMLFormElement | null;
  private readonly onSubmit: (event: SubmitEvent) => void;

  constructor(selector: string) {
    this.form = document.querySelector<HTMLFormElement>(selector);
    this.onSubmit = (event) => {
      event.preventDefault();
      const form = this.form;
      if (!form) return;

      const field = form.querySelector<HTMLElement>('.site-footer__field');
      const status = document.createElement('p');
      status.className = `${STATUS_CLASS} t-label t-label--accent`;
      // Announced rather than silently swapped: a form that changes under a
      // screen reader with no live region just appears to have done nothing.
      status.setAttribute('role', 'status');
      status.textContent = CONFIRMATION;
      field?.replaceWith(status);
    };
    this.form?.addEventListener('submit', this.onSubmit);
  }

  destroy(): void {
    this.form?.removeEventListener('submit', this.onSubmit);
  }
}
