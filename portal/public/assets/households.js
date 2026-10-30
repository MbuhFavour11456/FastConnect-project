async function householdRequest(path, options = {}) {
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
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}

const setHouseholdMessage = (element, message, state = "") => {
  element.textContent = message;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
};

const adminMessage = document.querySelector("#admin-message");

function cell(text, className = "") {
  const element = document.createElement("td");
  element.textContent = text ?? "—";
  if (className) element.className = className;
  return element;
}

function emptyRow(body, columns, message) {
  const row = document.createElement("tr");
  const item = document.createElement("td");
  item.colSpan = columns;
  item.className = "muted";
  item.textContent = message;
  row.append(item);
  body.replaceChildren(row);
}

async function loadHouseholds() {
  const [householdData, membershipData, sessionData] = await Promise.all([
    householdRequest("/api/admin/households"),
    householdRequest("/api/admin/household-memberships"),
    householdRequest("/api/admin/session"),
  ]);

  if (!sessionData.authenticated) {
    window.location.replace("/admin/login.html");
    return;
  }
  document.querySelector("#admin-name").textContent = sessionData.admin.fullName;

  const householdBody = document.querySelector("#household-list");
  const select = document.querySelector("#household-select");
  const previousSelection = select.value;
  householdBody.replaceChildren();
  select.replaceChildren(new Option("Choose a household", ""));

  for (const household of householdData.households) {
    const row = document.createElement("tr");
    row.append(
      cell(household.name),
      cell(`${household.owner.name} · ${household.owner.email}`),
      cell(String(household.activeMembers)),
      cell(String(household.pendingMembers)),
      cell(household.status),
      cell(household.id, "muted"),
    );
    householdBody.append(row);
    select.add(new Option(`${household.name} — ${household.owner.email}`, household.id));
  }
  if (previousSelection) select.value = previousSelection;
  if (!householdData.households.length) emptyRow(householdBody, 6, "No households yet.");

  const membershipBody = document.querySelector("#membership-list");
  membershipBody.replaceChildren();
  for (const membership of membershipData.memberships) {
    const row = document.createElement("tr");
    row.append(
      cell(membership.customer.name),
      cell(membership.customer.email),
      cell(membership.household.name),
      cell(membership.status),
      cell(membership.createdAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "Africa/Douala" }).format(new Date(membership.createdAt)) : "—"),
    );
    const actionCell = document.createElement("td");
    if (membership.status === "pending" || membership.status === "invited") {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "button small";
      approve.textContent = "Approve";
      approve.addEventListener("click", () => updateMembership(membership.id, "approve"));
      actionCell.append(approve);
    }
    if (membership.status === "active" || membership.status === "pending" || membership.status === "invited" || membership.status === "suspended") {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "button secondary small";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => updateMembership(membership.id, "revoke"));
      actionCell.append(revoke);
    }
    row.append(actionCell);
    membershipBody.append(row);
  }
  if (!membershipData.memberships.length) emptyRow(membershipBody, 6, "No household memberships yet.");
}

async function updateMembership(id, action) {
  const verb = action === "approve" ? "approve this family member" : "revoke this family member's access";
  if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
  try {
    const result = await householdRequest(`/api/admin/household-memberships/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    setHouseholdMessage(adminMessage, result.access ? `Membership approved. Access: ${result.access}.` : "Membership access updated.", "success");
    await loadHouseholds();
  } catch (error) {
    setHouseholdMessage(adminMessage, error.message, "error");
  }
}

document.querySelector("#household-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const message = document.querySelector("#household-form-message");
  const values = Object.fromEntries(new FormData(form).entries());
  submit.disabled = true;
  setHouseholdMessage(message, "Creating household…");
  try {
    const result = await householdRequest("/api/admin/households", { method: "POST", body: JSON.stringify(values) });
    form.reset();
    setHouseholdMessage(message, `Household created. Owner ${result.household.ownerEmail} has been approved for unlimited household access. Save the household ID from the table for your records.`, "success");
    await loadHouseholds();
  } catch (error) {
    setHouseholdMessage(message, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const message = document.querySelector("#member-form-message");
  const values = Object.fromEntries(new FormData(form).entries());
  submit.disabled = true;
  setHouseholdMessage(message, "Adding membership request…");
  try {
    const result = await householdRequest(`/api/admin/households/${encodeURIComponent(values.householdId)}/members`, {
      method: "POST",
      body: JSON.stringify({ email: values.email }),
    });
    form.elements.email.value = "";
    setHouseholdMessage(message, result.message, "success");
    await loadHouseholds();
  } catch (error) {
    setHouseholdMessage(message, error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#household-refresh").addEventListener("click", async () => {
  try {
    await loadHouseholds();
    setHouseholdMessage(adminMessage, "Household records refreshed.", "success");
  } catch (error) {
    setHouseholdMessage(adminMessage, error.message, "error");
  }
});

document.querySelector("#admin-logout").addEventListener("click", async () => {
  try {
    await householdRequest("/api/admin/logout", { method: "POST" });
    window.location.replace("/admin/login.html");
  } catch (error) {
    setHouseholdMessage(adminMessage, error.message, "error");
  }
});

loadHouseholds().catch((error) => {
  setHouseholdMessage(adminMessage, error.message, "error");
  if (/sign-in required/i.test(error.message)) window.location.replace("/admin/login.html");
});
