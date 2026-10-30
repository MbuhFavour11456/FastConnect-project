const apiRequest = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  const payload = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || 'The request could not be completed.');
  }

  return payload;
};

const setMessage = (element, message, state = '') => {
  if (!element) return;
  element.textContent = message;
  if (state) {
    element.dataset.state = state;
  } else {
    delete element.dataset.state;
  }
};

const getDeviceMac = () => {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('mac') ||
    params.get('mac-address') ||
    params.get('macAddress') ||
    ''
  ).trim();
};

const formatAmount = (amount) =>
  new Intl.NumberFormat('en-US').format(amount);

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Douala',
  }).format(date);
};

async function loadPlans() {
  const grid = document.querySelector('#plan-grid');
  if (!grid) return;

  const message = document.querySelector('#plans-message');
  try {
    const { plans } = await apiRequest('/api/plans');
    grid.replaceChildren();
    for (const [index, plan] of plans.entries()) {
      const card = document.createElement('article');
      card.className = `plan${index === 1 ? ' featured' : ''}`;
      card.dataset.planCard = plan.id;

      const top = document.createElement('div');
      top.className = 'plan-top';
      const duration = document.createElement('span');
      duration.className = index === 1 ? 'pill mint' : 'pill';
      duration.textContent = `${plan.days} ${plan.days === 1 ? 'day' : 'days'}`;
      const deviceLimit = document.createElement('span');
      deviceLimit.className = 'pill';
      deviceLimit.textContent = 'One device';
      top.append(duration, deviceLimit);

      const price = document.createElement('p');
      price.className = 'price';
      price.append(
        document.createTextNode(`${formatAmount(plan.priceXaf)} `),
        Object.assign(document.createElement('small'), { textContent: 'XAF' }),
      );
      const detail = document.createElement('p');
      detail.className = 'plan-detail';
      detail.textContent = plan.description;
      const link = document.createElement('a');
      link.className = 'button full';
      link.href = `checkout.html?plan=${encodeURIComponent(plan.id)}`;
      link.textContent = `Choose ${plan.days}-day plan`;
      card.append(top, price, detail, link);
      grid.append(card);
    }
    if (plans.length === 0) {
      setMessage(message, 'There are no plans available right now. Please contact the compound owner.');
    } else {
      setMessage(message, '');
    }
  } catch (error) {
    setMessage(message, `Could not load plans: ${error.message}`, 'error');
  }
}

async function setupCheckout() {
  const form = document.querySelector('#checkout-form');
  if (!form) return;

  const params = new URLSearchParams(window.location.search);
  const requestedPlan = params.get('plan');
  const planId =
    requestedPlan === '10'
      ? '10-day'
      : requestedPlan === '30'
        ? '30-day'
        : requestedPlan;
  const message = document.querySelector('#checkout-message');
  const deviceStatus = document.querySelector('#device-status');
  const submit = document.querySelector('#checkout-submit');
  const macAddress = getDeviceMac();
  let planIsAvailable = false;

  if (macAddress) {
    deviceStatus.textContent = 'Router supplied a device address';
  } else {
    deviceStatus.textContent = 'Waiting for Wi-Fi router details';
  }

  if (!planId) {
    setMessage(message, 'Select a plan from the plans page first.', 'error');
    submit.disabled = true;
    return;
  }

  try {
    const { plans } = await apiRequest('/api/plans');
    const plan = plans.find((availablePlan) => availablePlan.id === planId);

    if (!plan) {
      setMessage(message, 'The selected plan is not available.', 'error');
      submit.disabled = true;
      return;
    }

    document.querySelector('#plan-name').textContent = plan.name;
    document.querySelector('#plan-price').textContent =
      `${formatAmount(plan.priceXaf)} XAF`;
    planIsAvailable = true;
  } catch (error) {
    setMessage(message, `Could not load the selected plan: ${error.message}`, 'error');
    submit.disabled = true;
    return;
  }

  submit.disabled = !macAddress;
  if (!macAddress) {
    setMessage(
      message,
      'No device address came from the router. This test checkout is available only after the Wi-Fi portal supplies it.',
    );
  }

  document.querySelectorAll('[data-network]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-network]').forEach((option) => {
        const isSelected = option === button;
        option.classList.toggle('selected', isSelected);
        option.setAttribute('aria-pressed', String(isSelected));
      });
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!planIsAvailable || !macAddress || submit.disabled) return;

    const selectedNetwork = document.querySelector(
      '[data-network][aria-pressed="true"]',
    );
    submit.disabled = true;
    setMessage(message, 'Creating a sandbox order and payment request…');

    try {
      const order = await apiRequest('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          planId,
          macAddress,
          phoneNumber: document.querySelector('#phone-number').value,
          paymentNetwork: selectedNetwork.dataset.network,
        }),
      });

      const statusLink = document.querySelector('#order-status-link');
      statusLink.href = order.statusUrl;
      statusLink.hidden = false;
      const payment = await apiRequest(
        `/api/orders/${encodeURIComponent(order.order.reference)}/payment`,
        {
          method: 'POST',
          body: JSON.stringify({ macAddress }),
        },
      );
      setMessage(message, payment.message, 'success');
      submit.textContent = 'Sandbox payment request sent';
    } catch (error) {
      const statusLink = document.querySelector('#order-status-link');
      if (!statusLink.hidden) {
        setMessage(
          message,
          `The order was created, but its sandbox payment request could not be started: ${error.message}`,
          'error',
        );
        submit.textContent = 'Order created';
      } else {
        setMessage(message, error.message, 'error');
        submit.disabled = false;
      }
    }
  });
}

async function setupStatusPage() {
  const form = document.querySelector('#status-form');
  if (!form) return;

  const params = new URLSearchParams(window.location.search);
  const referenceInput = document.querySelector('#order-reference');
  const macInput = document.querySelector('#device-mac');
  const message = document.querySelector('#status-message');
  const resultPanel = document.querySelector('#order-status-result');
  const subscriptionDetails = document.querySelector('#subscription-details');
  referenceInput.value = params.get('reference') || '';
  macInput.value = params.get('mac') || '';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    resultPanel.hidden = true;
    setMessage(message, 'Looking up this test order…');

    try {
      const reference = referenceInput.value.trim();
      const macAddress = macInput.value.trim();
      const query = new URLSearchParams({ mac: macAddress });
      const order = await apiRequest(
        `/api/orders/${encodeURIComponent(reference)}?${query}`,
      );
      let currentOrderStatus = order.orderStatus;
      let paymentStatus = 'Not started';
      if (currentOrderStatus === 'pending') {
        try {
          const payment = await apiRequest(
            `/api/orders/${encodeURIComponent(reference)}/payment?${query}`,
          );
          paymentStatus = payment.paymentStatus || 'Not started';
          currentOrderStatus = payment.orderStatus || currentOrderStatus;
        } catch (error) {
          paymentStatus = `Could not verify: ${error.message}`;
        }
      } else if (currentOrderStatus === 'paid') {
        paymentStatus = 'successful';
      }

      document.querySelector('#order-status-label').textContent =
        `Order: ${currentOrderStatus}`;
      document.querySelector('#order-plan').textContent =
        `${order.plan.name} (${order.plan.days} days)`;
      document.querySelector('#order-amount').textContent =
        `${formatAmount(order.amountXaf)} XAF`;
      document.querySelector('#payment-status').textContent = paymentStatus;
      subscriptionDetails.hidden = !order.subscription;

      if (order.subscription) {
        document.querySelector('#subscription-start').textContent =
          formatDate(order.subscription.startedAt);
        document.querySelector('#subscription-expiry').textContent =
          formatDate(order.subscription.expiresAt);
      }

      resultPanel.hidden = false;
      setMessage(
        message,
        currentOrderStatus === 'paid'
          ? 'Sandbox payment verified. This preview has no router connected, so Wi-Fi access is not provided.'
          : currentOrderStatus === 'pending'
            ? 'This is a development order. A pending sandbox payment is not proof of payment or Wi-Fi access.'
            : '',
        currentOrderStatus === 'paid' ? 'success' : '',
      );
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  });

  if (referenceInput.value && macInput.value) {
    form.requestSubmit();
  }
}

loadPlans();
setupCheckout();
setupStatusPage();
