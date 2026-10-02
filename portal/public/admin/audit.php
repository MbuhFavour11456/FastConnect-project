<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Audit log</title>
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
				<a href="vouchers.php">Vouchers</a>
				<a class="active" href="audit.php">Audit log</a>
			</nav>
		</aside>

		<main class="admin-content">
			<div class="admin-heading">
				<div>
					<p class="eyebrow">Accountability</p>
					<h1>Audit log</h1>
					<p>Owner and system actions recorded for review.</p>
				</div>
				<a class="button secondary" href="#">Export log</a>
			</div>

			<section class="surface">
				<div class="toolbar">
					<input class="search-input" type="search" placeholder="Search by action or device">
					<select>
						<option>All activity</option>
						<option>Owner actions</option>
						<option>System events</option>
					</select>
					<select>
						<option>Today</option>
						<option>Last 7 days</option>
					</select>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Time</th>
								<th>Actor</th>
								<th>Event</th>
								<th>Details</th>
								<th>Result</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>10:14:06</td>
								<td>System</td>
								<td>Payment confirmed</td>
								<td>Order FC-261001-0142 · 2,000 XAF</td>
								<td>
									<span class="table-status">Success</span>
								</td>
							</tr>
							<tr>
								<td>10:14:08</td>
								<td>System</td>
								<td>Subscription created</td>
								<td>10-day plan · A4:8C:2F</td>
								<td>
									<span class="table-status">Success</span>
								</td>
							</tr>
							<tr>
								<td>09:31:42</td>
								<td>The Nkweti's</td>
								<td>Device approved</td>
								<td>Room 4 laptop · 71:BD:09</td>
								<td>
									<span class="table-status">Success</span>
								</td>
							</tr>
							<tr>
								<td>Yesterday</td>
								<td>System</td>
								<td>Payment reconciliation</td>
								<td>Order FC-300930-0122</td>
								<td>
									<span class="table-status pending">Retried</span>
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
