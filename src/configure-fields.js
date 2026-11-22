const form = document.getElementById('configure-settings');
const csrf = form.elements.namedItem('csrf').value;
const configurePath = form.getAttribute('action');
const copyLink = document.getElementById('copy-install-link');
if (copyLink) {
  const installLink = document.getElementById('install-manifest');
  const status = document.getElementById('copy-install-status');
  copyLink.hidden = false;
  copyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(installLink.value);
      status.textContent = 'Install link copied.';
    } catch {
      installLink.focus();
      installLink.select();
      status.textContent = 'Copy the selected install link.';
    }
  });
}
const position = form.elements.namedItem('EXACT_MATCH_POSITION');
const preview = document.getElementById('match-label-preview');
const examples = JSON.parse(preview.dataset.examples);
position.addEventListener('change', () => {
  preview.textContent = examples[position.value];
});

for (const input of form.querySelectorAll('textarea')) {
  form.addEventListener('formdata', ({ formData }) => {
    if (input.value === input.defaultValue) formData.delete(input.name);
    else if (!input.value.trim()) formData.set(`clear_${input.name}`, '1');
  });
}

for (const button of form.querySelectorAll('.visibility-toggle')) {
  const input = document.getElementById(button.getAttribute('aria-controls'));
  const error = document.getElementById(`error-${input.id}`);
  const label = input.labels[0].textContent;
  const saved = input.dataset.saved === 'true';
  let loaded = false;
  let edited = false;
  button.hidden = false;

  input.addEventListener('input', () => {
    edited = true;
    if (saved) input.placeholder = '';
    error.textContent = '';
  });

  form.addEventListener('formdata', ({ formData }) => {
    if (loaded && !edited) formData.delete(input.name);
    if (saved && edited && !input.value.trim()) formData.set(`clear_${input.name}`, '1');
  });

  button.addEventListener('click', async () => {
    const show = input.type === 'password';
    if (show && saved && !loaded && !edited && !input.value) {
      button.disabled = true;
      error.textContent = '';
      try {
        const response = await fetch(`${configurePath}/reveal`, {
          method: 'POST',
          body: new URLSearchParams({ csrf, field: input.name })
        });
        if (!response.ok) throw new Error('Could not load saved value');
        const { value } = await response.json();
        if (typeof value !== 'string') throw new Error('Invalid saved value');
        if (!edited && !input.value) {
          input.value = value;
          input.placeholder = '';
          loaded = true;
        }
      } catch {
        error.textContent = 'Could not load the saved value. Reload Configure and try again.';
        return;
      } finally {
        button.disabled = false;
      }
    }

    input.type = show ? 'text' : 'password';
    const action = `${show ? 'Hide' : 'Show'} ${label}`;
    button.setAttribute('aria-label', action);
    button.title = action;
  });
}

const requiredGroups = [...form.querySelectorAll('[data-required-message]')].map((section) => ({
  fields: [...section.querySelectorAll('input[name], textarea[name]')],
  error: section.querySelector('[data-required-error]'),
  message: section.dataset.requiredMessage
}));

form.addEventListener('submit', (event) => {
  const formData = new FormData(form);
  let firstMissing;
  for (const { fields, error, message } of requiredGroups) {
    const complete = fields.some((input) => formData.get(input.name)?.trim() ||
      (input.dataset.saved === 'true' && !formData.has(`clear_${input.name}`)));
    error.textContent = complete ? '' : message;
    if (!complete) firstMissing ??= fields[0];
  }
  if (firstMissing) {
    event.preventDefault();
    firstMissing.focus();
  }
});
