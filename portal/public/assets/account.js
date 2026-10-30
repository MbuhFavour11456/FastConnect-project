const accountApi = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });

  let payload = {};
  try {
    payload = response.status === 204 ? {} : await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(payload.error || "The request could not be completed.");
  }
  return payload;
};

const showMessage = (element, message, state = "") => {
  element.textContent = message;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
};

const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
const currentPanel = document.querySelector("#account-current");
const formsPanel = document.querySelector("#account-forms");

const formatSubscriptionDate = (value) => {
  if (!value) return "Not started";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Douala",
  }).format(date);
};

async function loadCustomerSubscriptions() {
  const container = document.querySelector("#customer-subscriptions");
  const message = document.querySelector("#subscriptions-message");
  if (!container || !message) return;

  try {
    const result = await accountApi("/api/account/subscriptions");
    container.replaceChildren();
    if (result.subscriptions.length === 0) {
      showMessage(message, "You do not have any subscriptions on this account yet.");
      return;
    }

    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["Plan", "Status", "Started", "Expires", "Order"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headerRow.append(cell);
    }
    head.append(headerRow);
    const body = document.createElement("tbody");
    for (const subscription of result.subscriptions) {
      const row = document.createElement("tr");
      const values = [
        `${subscription.plan.name} (${subscription.plan.days} days)`,
        subscription.status,
        formatSubscriptionDate(subscription.startedAt),
        formatSubscriptionDate(subscription.expiresAt),
        subscription.orderReference,
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    container.append(table);
    showMessage(message, "");
  } catch (error) {
    showMessage(message, error.message, "error");
  }
}

function renderCustomer(customer) {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    window.location.replace(next);
    return;
  }
  document.querySelector("#account-name").textContent = customer.fullName;
  document.querySelector("#account-email").textContent = customer.email;
  currentPanel.hidden = false;
  formsPanel.hidden = true;
  loadCustomerSubscriptions();
}

async function loadAccountSession() {
  try {
    const result = await accountApi("/api/account/session");
    if (result.authenticated) renderCustomer(result.customer);
  } catch {
    // Keep sign-in usable when the account API has not been deployed yet.
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector('button[type="submit"]');
  const message = document.querySelector("#login-message");
  submit.disabled = true;
  showMessage(message, "Signing in…");

  try {
    const form = new FormData(loginForm);
    const result = await accountApi("/api/account/login", {
      method: "POST",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    renderCustomer(result.customer);
    loginForm.reset();
  } catch (error) {
    showMessage(message, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = registerForm.querySelector('button[type="submit"]');
  const message = document.querySelector("#register-message");
  submit.disabled = true;
  showMessage(message, "Creating your account…");

  try {
    const form = new FormData(registerForm);
    const result = await accountApi("/api/account/register", {
      method: "POST",
      body: JSON.stringify({
        fullName: form.get("fullName"),
        email: form.get("email"),
        phoneNumber: form.get("phoneNumber"),
        password: form.get("password"),
      }),
    });
    registerForm.reset();
    showMessage(
      message,
      `${result.message} You can now sign in with your new account.`,
      "success",
    );
  } catch (error) {
    showMessage(message, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#account-logout").addEventListener("click", async () => {
  const button = document.querySelector("#account-logout");
  button.disabled = true;
  try {
    await accountApi("/api/account/logout", { method: "POST" });
    currentPanel.hidden = true;
    formsPanel.hidden = false;
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
});

loadAccountSession();
