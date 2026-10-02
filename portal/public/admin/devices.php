<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Devices</title>
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
				<a class="active" href="devices.php">Devices</a>
				<a href="subscriptions.php">Subscriptions</a>
				<a href="payments.php">Payments</a>
				<a href="vouchers.php">Vouchers</a>
				<a href="audit.php">Audit log</a>
			</nav>
		</aside>

		<main class="admin-content">
			<div class="admin-heading">
				<div>
					<p class="eyebrow">Network access</p>
					<h1>Devices</h1>
					<p>Review new devices and manage authorized access.</p>
				</div>
				<span class="pill mint">3 awaiting review</span>
			</div>

			<section class="surface">
				<div class="toolbar">
					<input class="search-input" type="search" placeholder="Search device or tenant">
					<select>
						<option>All devices</option>
						<option>Awaiting approval</option>
						<option>Authorized</option>
					</select>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Device</th>
								<th>First seen</th>
								<th>MAC address</th>
								<th>Access</th>
								<th>Action</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>Tenant phone</td>
								<td>Today, 10:14</td>
								<td class="muted">A4:8C:2F:19:6B:21</td>
								<td>
									<span class="table-status pending">Review</span>
								</td>
								<td>
									<a class="row-action" href="#">Approve</a>
								</td>
							</tr>
							<tr>
								<td>Tenant laptop</td>
								<td>Today, 09:52</td>
								<td class="muted">71:BD:09:41:03:C8</td>
								<td>
									<span class="table-status pending">Review</span>
								</td>
								<td>
									<a class="row-action" href="#">Approve</a>
								</td>
							</tr>
							<tr>
								<td>Room 4 phone</td>
								<td>Yesterday, 18:23</td>
								<td class="muted">C2:54:16:AA:2C:17</td>
								<td>
									<span class="table-status">Authorized</span>
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
