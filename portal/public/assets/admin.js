const setAdminMessage = (message, state = '') => {
  const element = document.querySelector('#admin-message');
  if (!element) return;
  element.textContent = message;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
};

async function adminRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'The request could not be completed.');
  return payload;
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function formatAdminDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Douala',
  }).format(date);
}

function setOwnerGreeting() {
  const dateElement = document.querySelector('#owner-date');
  const greetingElement = document.querySelector('#owner-greeting');
  if (!dateElement || !greetingElement) return;
  const now = new Date();
  dateElement.textContent =
    new Intl.DateTimeFormat('en', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Africa/Douala',
    }).format(now).toUpperCase();
  const hour = Number(new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: 'Africa/Douala',
  }).format(now));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  greetingElement.textContent = greeting;
}

function setupPasswordVisibility() {
  const openEyePath = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z';
  const closedEyePath = 'm3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a16.5 16.5 0 0 1-3.1 3.9M6.2 6.2C3.5 8.1 2 12 2 12s3.6 7 10 7a10.8 10.8 0 0 0 4-.8';
  document.querySelectorAll('.password-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.getAttribute('aria-controls'));
      if (!(input instanceof HTMLInputElement)) return;
      const showPassword = input.type === 'password';
      input.type = showPassword ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(showPassword));
      const fieldName = input.name === 'setupToken' ? 'one-time setup token' : 'password';
      button.setAttribute(
        'aria-label',
        `${showPassword ? 'Hide' : 'Show'} ${fieldName}`,
      );
      button.querySelector('.password-eye path').setAttribute(
        'd',
        showPassword ? closedEyePath : openEyePath,
      );
    });
  });
}

async function setupLoginPage() {
  const form = document.querySelector('#admin-login-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    setAdminMessage('Signing in…');
    try {
      await adminRequest('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify(formValues(form)),
      });
      window.location.assign('/admin/');
    } catch (error) {
      setAdminMessage(error.message, 'error');
      submit.disabled = false;
    }
  });
}

async function setupAdminBootstrap() {
  const form = document.querySelector('#admin-setup-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    setAdminMessage('Creating the administrator…');
    try {
      await adminRequest('/api/admin/setup', {
        method: 'POST',
        body: JSON.stringify(formValues(form)),
      });
      form.reset();
      setAdminMessage('Administrator created. Sign in with the username and password you just set.', 'success');
      window.setTimeout(() => window.location.assign('/admin/login.html'), 1200);
    } catch (error) {
      setAdminMessage(error.message, 'error');
      submit.disabled = false;
    }
  });
}

async function loadAdminOrders() {
  const tableBody = document.querySelector('#admin-orders-list');
  if (!tableBody) return;
  const message = document.querySelector('#admin-orders-message');
  try {
    const { orders } = await adminRequest('/api/admin/orders');
    tableBody.replaceChildren();
    for (const order of orders) {
      const row = document.createElement('tr');
      const values = [
        order.reference,
        `${order.plan.name} (${order.plan.days} days)`,
        `${new Intl.NumberFormat('en-US').format(order.amountXaf)} XAF`,
        order.status,
        formatAdminDate(order.createdAt),
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      tableBody.append(row);
    }
    if (orders.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'muted';
      cell.textContent = 'No orders yet.';
      row.append(cell);
      tableBody.append(row);
    }
    message.textContent = `${orders.length} most recent order${orders.length === 1 ? '' : 's'} shown.`;
    delete message.dataset.state;
  } catch (error) {
    message.textContent = error.message;
    message.dataset.state = 'error';
  }
}

async function loadAdminOverview() {
  const dashboard = document.querySelector('#admin-subscriptions-active');
  if (!dashboard) return;
  try {
    const session = await adminRequest('/api/admin/session');
    if (!session.authenticated) {
      window.location.replace('/admin/login.html');
      return;
    }
    document.querySelector('#admin-name').textContent = session.admin.fullName;
    const overview = await adminRequest('/api/admin/overview');
    document.querySelector('#admin-subscriptions-active').textContent = overview.activeSubscriptions;
    document.querySelector('#admin-payments-pending').textContent = overview.pendingPayments;
    document.querySelector('#admin-revenue-today').textContent =
      `${new Intl.NumberFormat('en-US').format(overview.revenueTodayXaf)} XAF`;
    document.querySelector('#admin-confirmed-today').textContent =
      `${overview.confirmedPaymentsToday} confirmed development payment${overview.confirmedPaymentsToday === 1 ? '' : 's'}`;
    document.querySelector('#admin-devices-pending').textContent = overview.devices.pending;
    setAdminMessage('');
    await loadAdminOrders();
  } catch (error) {
    setAdminMessage(error.message, 'error');
  }
}

const adminSections = {
  devices: {
    eyebrow: 'Network access',
    title: 'Devices',
    description: 'Review registered devices and their development access status.',
    endpoint: '/api/admin/devices',
    collection: 'devices',
    columns: ['Device', 'First seen', 'MAC address', 'Access', 'Action'],
    search: 'Search device or MAC address',
    filters: [
      ['all', 'All devices'],
      ['pending', 'Awaiting approval'],
      ['active', 'Authorized'],
      ['blocked', 'Blocked'],
    ],
    getStatus: (item) => item.status,
    getValues: (item) => [
      item.name || 'Unnamed device',
      formatAdminDate(item.firstSeenAt),
      item.macAddress,
      item.status,
      item.status === 'pending' ? 'Approval unavailable' : 'Details unavailable',
    ],
    unavailableAction: true,
  },
  subscriptions: {
    eyebrow: 'Tenant access',
    title: 'Subscriptions',
    description: 'Review recorded subscriptions. Router changes are not available in this preview.',
    endpoint: '/api/admin/subscriptions',
    collection: 'subscriptions',
    columns: ['Device', 'Plan', 'Started', 'Expires', 'Status', 'Actions'],
    search: 'Search by device or MAC address',
    filters: [
      ['all', 'All statuses'],
      ['active', 'Active'],
      ['expired', 'Expired'],
      ['pending', 'Pending'],
      ['revoked', 'Revoked'],
    ],
    getStatus: (item) => item.status,
    getValues: (item) => [
      `${item.deviceName || 'Unnamed device'} · ${item.macAddress}`,
      `${item.plan.days} days`,
      formatAdminDate(item.startedAt),
      formatAdminDate(item.expiresAt),
      item.status,
      'Management unavailable',
    ],
    unavailableAction: true,
  },
  payments: {
    eyebrow: 'Transactions',
    title: 'Payments',
    description: 'Review development payment records. Live payment processing is not connected.',
    endpoint: '/api/admin/payments',
    collection: 'payments',
    columns: ['Order reference', 'Phone', 'Plan', 'Amount', 'Created', 'Status'],
    search: 'Search by reference or phone suffix',
    filters: [
      ['all', 'All statuses'],
      ['successful', 'Successful'],
      ['pending', 'Pending'],
      ['failed', 'Failed'],
      ['expired', 'Expired'],
      ['amount_mismatch', 'Amount mismatch'],
    ],
    periodFilters: [
      ['all', 'Any date'],
      ['today', 'Today'],
      ['last7', 'Last 7 days'],
      ['month', 'This month'],
    ],
    exportName: 'fastconnect-development-payments.csv',
    csvHeaders: ['Order reference', 'Phone (masked)', 'Plan', 'Network', 'Amount XAF', 'Created', 'Status'],
    csvValues: (item) => [
      item.reference,
      `•••• ${item.phoneSuffix}`,
      `${item.plan.days} days`,
      item.network.toUpperCase(),
      item.amountXaf,
      item.createdAt,
      item.status,
    ],
    getStatus: (item) => item.status,
    getDate: (item) => item.createdAt,
    getValues: (item) => [
      item.reference,
      `•••• ${item.phoneSuffix}`,
      `${item.plan.days} days · ${item.network.toUpperCase()}`,
      `${new Intl.NumberFormat('en-US').format(item.amountXaf)} XAF`,
      formatAdminDate(item.createdAt),
      item.status,
    ],
  },
  audit: {
    eyebrow: 'Accountability',
    title: 'Audit log',
    description: 'Owner and system events recorded in the development database.',
    endpoint: '/api/admin/audit',
    collection: 'entries',
    columns: ['Time', 'Actor', 'Event', 'Details', 'Result'],
    search: 'Search by action or details',
    filters: [
      ['all', 'All activity'],
      ['owner', 'Owner actions'],
      ['system', 'System events'],
    ],
    periodFilters: [
      ['all', 'Any date'],
      ['today', 'Today'],
      ['last7', 'Last 7 days'],
      ['month', 'This month'],
    ],
    exportName: 'fastconnect-audit-log.csv',
    csvHeaders: ['Time', 'Actor', 'Event', 'Details', 'Result'],
    csvValues: (item) => [
      item.createdAt,
      item.actor,
      item.action,
      item.details || '',
      item.result,
    ],
    getStatus: () => 'recorded',
    getDate: (item) => item.createdAt,
    getActor: (item) => item.actorType,
    getValues: (item) => [
      formatAdminDate(item.createdAt),
      item.actor,
      item.action,
      item.details || '—',
      item.result,
    ],
  },
};

function setSectionStatus(cell, status) {
  const badge = document.createElement('span');
  badge.className = 'table-status';
  if (status === 'pending' || status === 'amount_mismatch') badge.classList.add('pending');
  else if (status === 'failed' || status === 'expired' || status === 'blocked' || status === 'revoked') {
    badge.classList.add('expired');
  }
  badge.textContent = status.replaceAll('_', ' ');
  cell.append(badge);
}

function renderSectionRows(tableBody, config, items) {
  tableBody.replaceChildren();
  for (const item of items) {
    const row = document.createElement('tr');
    const status = config.getStatus(item);
    row.dataset.status = status;
    if (config.getDate) row.dataset.date = config.getDate(item) || '';
    if (config.getActor) row.dataset.actor = config.getActor(item);
    for (const [index, value] of config.getValues(item).entries()) {
      const cell = document.createElement('td');
      if (index === config.columns.length - 2 && config.collection === 'devices') {
        setSectionStatus(cell, status);
      } else if (index === config.columns.length - 2 && config.collection === 'subscriptions') {
        setSectionStatus(cell, status);
      } else if (index === config.columns.length - 1 && config.collection === 'payments') {
        setSectionStatus(cell, status);
      } else if (index === config.columns.length - 1 && config.collection === 'audit') {
        setSectionStatus(cell, status);
      } else if (config.unavailableAction && index === config.columns.length - 1) {
        const action = document.createElement('span');
        action.className = 'muted';
        action.textContent = value;
        cell.append(action);
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    }
    tableBody.append(row);
  }
  if (items.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = config.columns.length;
    cell.className = 'muted';
    cell.textContent = `No ${config.collection === 'entries' ? 'audit events' : config.collection} recorded yet.`;
    row.append(cell);
    tableBody.append(row);
  }
}

function cameroonDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Africa/Douala',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function isInSelectedPeriod(value, period) {
  if (period === 'all') return true;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const parts = cameroonDateParts(date);
  const nowParts = cameroonDateParts();
  if (period === 'today') {
    return parts.year === nowParts.year && parts.month === nowParts.month && parts.day === nowParts.day;
  }
  if (period === 'month') {
    return parts.year === nowParts.year && parts.month === nowParts.month;
  }
  if (period === 'last7') {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return date.getTime() >= cutoff && date.getTime() <= Date.now();
  }
  return true;
}

function csvSafeValue(value) {
  const text = String(value ?? '');
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, headers, rows) {
  const content = [headers, ...rows]
    .map((row) => row.map(csvSafeValue).join(','))
    .join('\r\n');
  const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderVoucherPreview(container, plans) {
  container.innerHTML = `
    <section class="content-grid">
      <article class="surface">
        <div class="panel-heading"><h2>Create a cash voucher</h2></div>
        <p class="field-hint">Generate a one-time code after recording a cash payment. The code is shown once and stored as a keyed hash.</p>
        <form id="voucher-create-form" class="form-stack" aria-label="Create cash voucher">
          <label class="field">Subscription plan
            <select name="planId" required></select>
          </label>
          <label class="field">Tenant or room note
            <input name="note" type="text" maxlength="120" placeholder="e.g. Room 3">
          </label>
          <button class="button" type="submit">Generate one-time code</button>
        </form>
        <p id="voucher-create-message" class="form-message" role="status" aria-live="polite"></p>
      </article>
      <article id="voucher-last-generated" class="surface" hidden>
        <div class="panel-heading"><h2>Last generated</h2><span class="pill mint">Code shown once</span></div>
        <p class="eyebrow">Voucher code</p>
        <p id="voucher-generated-code" class="price voucher-code"></p>
        <p id="voucher-generated-details" class="field-hint"></p>
        <div class="inline-note"><span>This code is not redeemable yet. Voucher redemption and Wi-Fi activation remain disabled until the router is integrated.</span></div>
      </article>
    </section>
    <section class="surface spaced">
      <div class="panel-heading"><h2>Recent vouchers</h2></div>
      <div class="toolbar">
        <input id="voucher-search" class="search-input" type="search" placeholder="Search plan or tenant note" aria-label="Search vouchers">
        <select id="voucher-status-filter" aria-label="Filter vouchers by status">
          <option value="all">All statuses</option>
          <option value="unused">Unused</option>
          <option value="cancelled">Cancelled</option>
          <option value="redeemed">Redeemed</option>
        </select>
        <select id="voucher-period-filter" aria-label="Filter vouchers by creation date">
          <option value="all">All dates</option>
          <option value="today">Today</option>
          <option value="last7">Last 7 days</option>
          <option value="month">This month</option>
        </select>
        <button id="voucher-export" class="button secondary" type="button">Export visible CSV</button>
      </div>
      <p id="voucher-list-count" class="field-hint">Showing the latest 100 vouchers. Export omits voucher codes.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Code</th><th>Plan</th><th>Created</th><th>Tenant / redemption</th><th>Status</th><th>Action</th></tr></thead>
          <tbody id="admin-vouchers-list"><tr><td class="muted" colspan="6">Loading vouchers…</td></tr></tbody>
        </table>
      </div>
      <p id="admin-vouchers-message" class="form-message" role="status" aria-live="polite"></p>
    </section>
    <div class="inline-note"><span>Creating a voucher records a cash payment only. Codes cannot be redeemed, and no subscription or Wi-Fi access is granted by this development portal.</span></div>`;

  const select = container.querySelector('select[name="planId"]');
  for (const plan of plans.filter((item) => item.isActive)) {
    const option = document.createElement('option');
    option.value = plan.id;
    option.textContent =
      `${plan.name} · ${plan.days} days · ${new Intl.NumberFormat('en-US').format(plan.priceXaf)} XAF`;
    select.append(option);
  }
  const form = container.querySelector('#voucher-create-form');
  const submit = form.querySelector('button[type="submit"]');
  if (select.options.length === 0) {
    select.disabled = true;
    submit.disabled = true;
    container.querySelector('#voucher-create-message').textContent =
      'There are no active plans. Enable a plan before creating vouchers.';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    container.querySelector('#voucher-create-message').textContent = 'Generating a secure voucher…';
    try {
      const { voucher } = await adminRequest('/api/admin/vouchers', {
        method: 'POST',
        body: JSON.stringify({
          planId: select.value,
          note: form.elements.note.value,
        }),
      });
      container.querySelector('#voucher-generated-code').textContent = voucher.code;
      container.querySelector('#voucher-generated-details').textContent =
        `${voucher.plan.name} · ${voucher.plan.days} days · ${new Intl.NumberFormat('en-US').format(voucher.amountXaf)} XAF${voucher.note ? ` · ${voucher.note}` : ''}`;
      container.querySelector('#voucher-last-generated').hidden = false;
      container.querySelector('#voucher-create-message').textContent =
        'Voucher created. Copy the code now; it cannot be viewed again.';
      form.elements.note.value = '';
      setAdminMessage('Cash voucher created. Redemption remains disabled until router integration.', 'success');
      await loadAdminVouchers();
    } catch (error) {
      container.querySelector('#voucher-create-message').textContent = error.message;
      setAdminMessage(error.message, 'error');
    } finally {
      submit.disabled = select.disabled;
    }
  });
}

function renderAdminVouchers(vouchers) {
  const tableBody = document.querySelector('#admin-vouchers-list');
  const search = document.querySelector('#voucher-search');
  const statusFilter = document.querySelector('#voucher-status-filter');
  const periodFilter = document.querySelector('#voucher-period-filter');
  const count = document.querySelector('#voucher-list-count');
  const matchesFilters = (voucher) => {
    const query = search.value.trim().toLowerCase();
    const searchMatch = !query ||
      [voucher.plan.name, voucher.note, voucher.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    const statusMatch =
      statusFilter.value === 'all' || voucher.status === statusFilter.value;
    const periodMatch = isInSelectedPeriod(voucher.createdAt, periodFilter.value);
    return searchMatch && statusMatch && periodMatch;
  };
  const updateRows = () => {
    const visibleVouchers = vouchers.filter(matchesFilters);
    tableBody.replaceChildren();
    if (visibleVouchers.length === 0) {
      const row = document.createElement('tr');
      const empty = document.createElement('td');
      empty.className = 'muted';
      empty.colSpan = 6;
      empty.textContent = vouchers.length === 0
        ? 'No vouchers have been generated.'
        : 'No vouchers match these filters.';
      row.append(empty);
      tableBody.append(row);
      count.textContent = `0 of ${vouchers.length} vouchers shown.`;
      return;
    }

    count.textContent = `${visibleVouchers.length} of ${vouchers.length} vouchers shown.`;
    for (const voucher of visibleVouchers) {
    const row = document.createElement('tr');
    const code = document.createElement('td');
    code.textContent = 'Hidden after creation';
    const plan = document.createElement('td');
    plan.textContent = `${voucher.plan.name} (${voucher.plan.days} days)`;
    const created = document.createElement('td');
    created.textContent = formatAdminDate(voucher.createdAt);
    const redemption = document.createElement('td');
    redemption.textContent = voucher.redeemedBy
      ? voucher.redeemedBy.name || voucher.redeemedBy.macAddress
      : voucher.note || 'Not redeemed';
    const status = document.createElement('td');
    status.textContent = voucher.status === 'unused'
      ? 'Unused · redemption disabled'
      : voucher.status === 'cancelled'
        ? 'Cancelled'
        : 'Redeemed';
    const action = document.createElement('td');
    if (voucher.status === 'unused') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button secondary';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try {
          await adminRequest(
            `/api/admin/vouchers/${encodeURIComponent(voucher.id)}/cancel`,
            { method: 'POST' },
          );
          setAdminMessage('Voucher cancelled.', 'success');
          await loadAdminVouchers();
        } catch (error) {
          setAdminMessage(error.message, 'error');
          cancel.disabled = false;
        }
      });
      action.append(cancel);
    } else {
      action.textContent = '—';
    }
    row.append(code, plan, created, redemption, status, action);
    tableBody.append(row);
    }
  }

  search.addEventListener('input', updateRows);
  statusFilter.addEventListener('change', updateRows);
  periodFilter.addEventListener('change', updateRows);
  document.querySelector('#voucher-export').addEventListener('click', () => {
    const visibleVouchers = vouchers.filter(matchesFilters);
    downloadCsv(
      'fastconnect-vouchers.csv',
      ['Plan', 'Duration (days)', 'Amount (XAF)', 'Tenant note', 'Status', 'Created at', 'Redeemed at', 'Cancelled at'],
      visibleVouchers.map((voucher) => [
        voucher.plan.name,
        voucher.plan.days,
        voucher.amountXaf,
        voucher.note || '',
        voucher.status,
        voucher.createdAt,
        voucher.redeemedAt || '',
        voucher.cancelledAt || '',
      ]),
    );
    setAdminMessage(`Exported ${visibleVouchers.length} filtered vouchers. Voucher codes are not included.`, 'success');
  });
  updateRows();
}

async function loadAdminVouchers() {
  const tableBody = document.querySelector('#admin-vouchers-list');
  if (!tableBody) return;
  try {
    const { vouchers } = await adminRequest('/api/admin/vouchers');
    renderAdminVouchers(vouchers);
  } catch (error) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'muted';
    cell.colSpan = 6;
    cell.textContent = `Could not load vouchers: ${error.message}`;
    row.replaceChildren(cell);
    tableBody.replaceChildren(row);
  }
}

function createPlanField(labelText, name, value, type = 'text', attributes = {}) {
  const label = document.createElement('label');
  label.className = 'field';
  label.append(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.name = name;
  input.type = type;
  input.value = value ?? '';
  input.required = true;
  for (const [key, attributeValue] of Object.entries(attributes)) {
    input.setAttribute(key, attributeValue);
  }
  label.append(input);
  return { label, input };
}

function renderAdminPlans(plans) {
  const list = document.querySelector('#admin-plans-list');
  list.replaceChildren();
  if (plans.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No plans have been created.';
    list.append(empty);
    return;
  }

  for (const plan of plans) {
    const article = document.createElement('article');
    article.className = 'admin-plan-item';
    const heading = document.createElement('h3');
    heading.textContent = `${plan.name} · ${plan.isActive ? 'Available' : 'Unavailable'}`;
    article.append(heading);

    const form = document.createElement('form');
    form.className = 'form-stack';
    form.dataset.planId = plan.id;
    const identity = document.createElement('p');
    identity.className = 'field-hint';
    identity.textContent = plan.termsLocked
      ? `Plan ID: ${plan.id} · Name and duration are locked because this plan has order or subscription history. Create a new plan to change its terms.`
      : `Plan ID: ${plan.id} · Used to identify this plan in existing orders.`;
    form.append(identity);

    const firstRow = document.createElement('div');
    firstRow.className = 'choice-row';
    const name = createPlanField('Plan name', 'name', plan.name, 'text', { maxlength: '80' });
    const days = createPlanField('Duration in days', 'days', plan.days, 'number', {
      min: '1',
      max: '365',
    });
    name.input.disabled = plan.termsLocked;
    days.input.disabled = plan.termsLocked;
    firstRow.append(name.label, days.label);

    const secondRow = document.createElement('div');
    secondRow.className = 'choice-row';
    const price = createPlanField('Price (XAF)', 'priceXaf', plan.priceXaf, 'number', {
      min: '1',
      max: '5000000',
      step: '1',
    });
    const description = createPlanField(
      'Description',
      'description',
      plan.description,
      'text',
      { maxlength: '240' },
    );
    secondRow.append(price.label, description.label);

    const activeLabel = document.createElement('label');
    activeLabel.className = 'field checkbox-field';
    const active = document.createElement('input');
    active.type = 'checkbox';
    active.name = 'isActive';
    active.checked = plan.isActive;
    activeLabel.append(active, document.createTextNode('Available on public plans page'));

    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'button';
    save.textContent = 'Save changes';
    form.append(firstRow, secondRow, activeLabel, save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      setAdminMessage(`Saving ${plan.name}…`);
      const values = formValues(form);
      try {
        await adminRequest(`/api/admin/plans/${encodeURIComponent(plan.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: name.input.value,
            days: Number(days.input.value),
            priceXaf: Number(values.priceXaf),
            description: values.description,
            isActive: active.checked,
          }),
        });
        setAdminMessage(`${plan.name} updated.`, 'success');
        await loadAdminPlans();
      } catch (error) {
        setAdminMessage(error.message, 'error');
        save.disabled = false;
      }
    });
    article.append(form);
    list.append(article);
  }
}

async function loadAdminPlans() {
  const list = document.querySelector('#admin-plans-list');
  if (!list) return;
  const { plans } = await adminRequest('/api/admin/plans');
  renderAdminPlans(plans);
}

async function setupAdminPlans() {
  const list = document.querySelector('#admin-plans-list');
  if (!list) return;
  const session = await adminRequest('/api/admin/session');
  if (!session.authenticated) {
    window.location.replace('/admin/login.html');
    return;
  }
  document.querySelector('#admin-name').textContent = session.admin.fullName;
  const form = document.querySelector('#admin-plan-create-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const values = formValues(form);
    submit.disabled = true;
    setAdminMessage('Creating plan…');
    try {
      await adminRequest('/api/admin/plans', {
        method: 'POST',
        body: JSON.stringify({
          id: values.id.trim(),
          name: values.name,
          days: Number(values.days),
          priceXaf: Number(values.priceXaf),
          description: values.description,
          isActive: form.elements.isActive.checked,
        }),
      });
      form.reset();
      form.elements.isActive.checked = true;
      setAdminMessage('Plan created.', 'success');
      await loadAdminPlans();
    } catch (error) {
      setAdminMessage(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
  document.querySelector('#admin-plans-refresh').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await loadAdminPlans();
      setAdminMessage('Plans refreshed.', 'success');
    } catch (error) {
      setAdminMessage(error.message, 'error');
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  await loadAdminPlans();
}

async function loadAdminSection() {
  const container = document.querySelector('#admin-section-content');
  if (!container) return;
  const section = new URLSearchParams(window.location.search).get('section');
  const config = adminSections[section];
  if (!config && section !== 'vouchers') {
    window.location.replace('/admin/');
    return;
  }
  const session = await adminRequest('/api/admin/session');
  if (!session.authenticated) {
    window.location.replace('/admin/login.html');
    return;
  }
  document.querySelector('#admin-name').textContent = session.admin.fullName;
  const activeLink = document.querySelector(`[data-section-link="${section}"]`);
  activeLink?.classList.add('active');
  activeLink?.setAttribute('aria-current', 'page');

  if (section === 'vouchers') {
    document.title = 'FastConnect | Vouchers';
    document.querySelector('#admin-section-eyebrow').textContent = 'Cash payments';
    document.querySelector('#admin-section-title').textContent = 'Vouchers';
    document.querySelector('#admin-section-description').textContent =
      'Record a cash payment and issue a one-time code. Redemption is not enabled until router integration.';
    try {
      const { plans } = await adminRequest('/api/admin/plans');
      renderVoucherPreview(container, plans);
      await loadAdminVouchers();
    } catch (error) {
      setAdminMessage(error.message, 'error');
      container.textContent = 'Could not load voucher tools. Please refresh and try again.';
    }
    return;
  }

  document.title = `FastConnect | ${config.title}`;
  document.querySelector('#admin-section-eyebrow').textContent = config.eyebrow;
  document.querySelector('#admin-section-title').textContent = config.title;
  document.querySelector('#admin-section-description').textContent = config.description;
  const badge = document.querySelector('#admin-section-badge');
  if (section === 'devices') {
    badge.hidden = false;
    badge.textContent = 'Loading devices';
  }
  container.innerHTML = `
    <section class="surface">
      <div class="toolbar">
        <input class="search-input" id="admin-section-search" type="search" placeholder="${config.search}" aria-label="${config.search}">
        <select id="admin-section-filter" aria-label="Filter ${config.title.toLowerCase()}">
          ${config.filters.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
        ${config.periodFilters ? `<select id="admin-section-period" aria-label="Filter by date">${config.periodFilters.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>` : ''}
        ${config.exportName ? '<button id="admin-section-export" class="button secondary" type="button">Export visible CSV</button>' : ''}
      </div>
      ${config.exportName ? '<p class="field-hint">Showing the latest 100 records. Export includes only records matching your current filters.</p>' : ''}
      <p id="admin-section-message" class="form-message" role="status" aria-live="polite"></p>
      <div class="table-wrap">
        <table>
          <thead><tr>${config.columns.map((column) => `<th scope="col">${column}</th>`).join('')}</tr></thead>
          <tbody id="admin-section-rows"></tbody>
        </table>
      </div>
    </section>`;
  try {
    const payload = await adminRequest(config.endpoint);
    const items = payload[config.collection];
    const tableBody = document.querySelector('#admin-section-rows');
    renderSectionRows(tableBody, config, items);
    if (section === 'devices') {
      const pending = items.filter((device) => device.status === 'pending').length;
      badge.textContent = `${pending} awaiting review`;
    }
    const search = document.querySelector('#admin-section-search');
    const filter = document.querySelector('#admin-section-filter');
    const period = document.querySelector('#admin-section-period');
    const updateVisibleRows = () => {
      const query = search.value.trim().toLowerCase();
      let visibleCount = 0;
      for (const row of tableBody.querySelectorAll('tr[data-status]')) {
        const visible =
          (!query || row.textContent.toLowerCase().includes(query)) &&
          (
            (filter.value === 'all' || (config.getActor ? row.dataset.actor === filter.value : row.dataset.status === filter.value))
          ) &&
          (!period || isInSelectedPeriod(row.dataset.date, period.value));
        row.hidden = !visible;
        if (visible) visibleCount += 1;
      }
      document.querySelector('#admin-section-message').textContent =
        `${visibleCount} ${config.collection} shown.`;
    };
    const exportButton = document.querySelector('#admin-section-export');
    if (exportButton) {
      exportButton.addEventListener('click', () => {
        const visibleItems = items.filter((item) => {
          const statusMatch = config.getActor
            ? filter.value === 'all' || config.getActor(item) === filter.value
            : filter.value === 'all' || config.getStatus(item) === filter.value;
          const queryMatch = !search.value.trim() ||
            config.getValues(item).join(' ').toLowerCase().includes(search.value.trim().toLowerCase());
          const periodMatch = !period || isInSelectedPeriod(config.getDate(item), period.value);
          return statusMatch && queryMatch && periodMatch;
        });
        downloadCsv(config.exportName, config.csvHeaders, visibleItems.map(config.csvValues));
        setAdminMessage(`Exported ${visibleItems.length} filtered ${config.collection}.`, 'success');
      });
    }
    search.addEventListener('input', updateVisibleRows);
    filter.addEventListener('change', updateVisibleRows);
    period?.addEventListener('change', updateVisibleRows);
    updateVisibleRows();
  } catch (error) {
    setAdminMessage(error.message, 'error');
  }
}

function setupAdminControls() {
  document.querySelector('#admin-refresh')?.addEventListener('click', loadAdminOverview);
  document.querySelector('#admin-logout')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await adminRequest('/api/admin/logout', { method: 'POST' });
      window.location.replace('/admin/login.html');
    } catch (error) {
      setAdminMessage(error.message, 'error');
      button.disabled = false;
    }
  });
}

async function setupAdminPasswordChange() {
  const form = document.querySelector('#admin-password-form');
  if (!form) return;
  const session = await adminRequest('/api/admin/session');
  if (!session.authenticated) {
    window.location.replace('/admin/login.html');
    return;
  }
  document.querySelector('#admin-name').textContent = session.admin.fullName;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = formValues(form);
    if (values.newPassword !== values.confirmPassword) {
      setAdminMessage('The new password and confirmation do not match.', 'error');
      return;
    }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    setAdminMessage('Updating password…');
    try {
      await adminRequest('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });
      form.reset();
      setAdminMessage('Password changed. Sign in again with the new password.', 'success');
      window.setTimeout(() => window.location.replace('/admin/login.html'), 1200);
    } catch (error) {
      setAdminMessage(error.message, 'error');
      submit.disabled = false;
    }
  });
}

setupLoginPage();
setupAdminBootstrap();
setupAdminControls();
setupPasswordVisibility();
setOwnerGreeting();
loadAdminOverview();
loadAdminSection().catch((error) => setAdminMessage(error.message, 'error'));
setupAdminPasswordChange().catch((error) => setAdminMessage(error.message, 'error'));
setupAdminPlans().catch((error) => setAdminMessage(error.message, 'error'));
