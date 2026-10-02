<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Vouchers</title>
	<link rel="stylesheet" href="../assets/style.css">
</head>

<body class="admin-app">
	<header class="admin-topbar">
		<div class="admin-topbar-left">
			<a class="brand" href="dashboard.php">
				<span class="brand-mark">F</span>
				<span class="brand-name">FastConnect</span>
			</a>
			<span class="pill">Owner portal</span>
		</div>
		<div class="admin-user">
			<strong>The Nkweti's</strong>
			<a class="button secondary" href="login.php">Sign out</a>
		</div>
	</header>

	<div class="admin-layout">
		<aside class="sidebar">
			<p class="side-label">Workspace</p>
			<nav class="side-nav">
				<a href="dashboard.php">Overview</a>
				<a href="devices.php">Devices</a>
				<a href="subscriptions.php">Subscriptions</a>
				<a href="payments.php">Payments</a>
				<a class="active" href="vouchers.php">Vouchers</a>
				<a href="audit.php">Audit log</a>
			</nav>
		</aside>

		<main class="admin-content">
			<div class="admin-heading">
				<div>
					<p class="eyebrow">Cash payments</p>
					<h1>Vouchers</h1>
					<p>Create a one-time code for a tenant who paid in cash.</p>
				</div>
			</div>

			<section class="content-grid">
				<article class="surface">
					<div class="panel-heading">
						<h2>Create a voucher</h2>
					</div>
					<form class="form-stack" action="#">
						<label class="field">
							Subscription plan
							<select>
								<option>10 days · 2,000 XAF</option>
								<option>30 days · 5,000 XAF</option>
							</select>
						</label>
						<label class="field">
							Tenant or room note
							<input type="text" placeholder="e.g. Room 3">
						</label>
						<button class="button" type="button">Generate one-time code</button>
					</form>
				</article>
				<article class="surface">
					<div class="panel-heading">
						<h2>Last generated</h2>
						<span class="pill mint">Unused</span>
					</div>
					<p class="eyebrow">Voucher code</p>
					<p class="price">FC-7K4P-29Q</p>
					<p class="field-hint">10-day plan · Created just now</p>
					<div class="inline-note">
						<span>
							Share this code with the tenant. It can only be redeemed once and will be linked to their
							device.
						</span>
					</div>
				</article>
			</section>

			<section class="surface spaced">
				<div class="panel-heading">
					<h2>Recent vouchers</h2>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Code</th>
								<th>Plan</th>
								<th>Created</th>
								<th>Redeemed by</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>FC-7K4P-29Q</td>
								<td>10 days</td>
								<td>Just now</td>
								<td class="muted">—</td>
								<td>
									<span class="table-status pending">Unused</span>
								</td>
							</tr>
							<tr>
								<td>FC-8L2R-11M</td>
								<td>30 days</td>
								<td>Yesterday</td>
								<td>Room 2 phone</td>
								<td>
									<span class="table-status">Redeemed</span>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>
		</main>
	</div>
</body>
</html>
