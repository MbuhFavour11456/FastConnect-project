<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Subscriptions</title>
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
				<a class="active" href="subscriptions.php">Subscriptions</a>
				<a href="payments.php">Payments</a>
				<a href="vouchers.php">Vouchers</a>
				<a href="audit.php">Audit log</a>
			</nav>
		</aside>

		<main class="admin-content">
			<div class="admin-heading">
				<div>
					<p class="eyebrow">Tenant access</p>
					<h1>Subscriptions</h1>
					<p>Search, extend, re-bind, or revoke access.</p>
				</div>
			</div>

			<section class="surface">
				<div class="toolbar">
					<input class="search-input" type="search" placeholder="Search by device or MAC address">
					<select>
						<option>All statuses</option>
						<option>Active</option>
						<option>Expired</option>
					</select>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Device</th>
								<th>Plan</th>
								<th>Started</th>
								<th>Expires</th>
								<th>Status</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>Room 2 · A4:8C:2F</td>
								<td>30 days</td>
								<td>01 Oct 2026</td>
								<td>31 Oct 2026</td>
								<td>
									<span class="table-status">Active</span>
								</td>
								<td>
									<a class="row-action" href="#">Manage</a>
								</td>
							</tr>
							<tr>
								<td>Room 4 · C2:54:16</td>
								<td>10 days</td>
								<td>26 Sep 2026</td>
								<td>06 Oct 2026</td>
								<td>
									<span class="table-status">Active</span>
								</td>
								<td>
									<a class="row-action" href="#">Manage</a>
								</td>
							</tr>
							<tr>
								<td>Room 1 · 55:14:BD</td>
								<td>10 days</td>
								<td>10 Sep 2026</td>
								<td>20 Sep 2026</td>
								<td>
									<span class="table-status expired">Expired</span>
								</td>
								<td>
									<a class="row-action" href="#">Details</a>
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
