<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Payments</title>
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
				<a class="active" href="payments.php">Payments</a>
				<a href="vouchers.php">Vouchers</a>
				<a href="audit.php">Audit log</a>
			</nav>
		</aside>

		<main class="admin-content">
			<div class="admin-heading">
				<div>
					<p class="eyebrow">Transactions</p>
					<h1>Payments</h1>
					<p>Review payment attempts and reconciliation status.</p>
				</div>
				<a class="button secondary" href="#">Export CSV</a>
			</div>

			<section class="surface">
				<div class="toolbar">
					<input class="search-input" type="search" placeholder="Phone, reference, MAC address">
					<select>
						<option>All statuses</option>
						<option>Paid</option>
						<option>Pending</option>
						<option>Failed</option>
					</select>
					<select>
						<option>Today</option>
						<option>Last 7 days</option>
						<option>This month</option>
					</select>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Order reference</th>
								<th>Phone</th>
								<th>Plan</th>
								<th>Amount</th>
								<th>Created</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>FC-261001-0142</td>
								<td>+237 6•• •• 42 18</td>
								<td>10 days</td>
								<td>2,000 XAF</td>
								<td>10:14</td>
								<td>
									<span class="table-status">Paid</span>
								</td>
							</tr>
							<tr>
								<td>FC-261001-0141</td>
								<td>+237 6•• •• 09 63</td>
								<td>30 days</td>
								<td>5,000 XAF</td>
								<td>09:58</td>
								<td>
									<span class="table-status pending">Pending</span>
								</td>
							</tr>
							<tr>
								<td>FC-261001-0140</td>
								<td>+237 6•• •• 17 05</td>
								<td>10 days</td>
								<td>2,000 XAF</td>
								<td>09:42</td>
								<td>
									<span class="table-status">Paid</span>
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
