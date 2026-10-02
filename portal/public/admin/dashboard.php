<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Dashboard</title>
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
				<a class="active" href="dashboard.php">Overview</a>
				<a href="devices.php">Devices</a>
				<a href="subscriptions.php">Subscriptions</a>
				<a href="payments.php">Payments</a>
				<a href="vouchers.php">Vouchers</a>
				<a href="audit.php">Audit log</a>
			</nav>
		</aside>

		<main class="admin-content">
			<div class="admin-heading">
				<div>
					<p class="eyebrow">Thursday, 1 October 2026</p>
					<h1>Good morning</h1>
					<p>Here’s the latest activity on your compound network.</p>
				</div>
				<a class="button" href="devices.php">Review devices</a>
			</div>

			<section class="stat-grid">
				<article class="surface stat">
					<p class="stat-label">Active subscriptions</p>
					<p class="stat-value">38</p>
					<p class="stat-foot">+4 this week</p>
				</article>
				<article class="surface stat">
					<p class="stat-label">Revenue today</p>
					<p class="stat-value">
						12,000
						<small>XAF</small>
					</p>
					<p class="stat-foot">3 confirmed payments</p>
				</article>
				<article class="surface stat">
					<p class="stat-label">Pending payments</p>
					<p class="stat-value">2</p>
					<p class="stat-foot attention">Needs follow-up</p>
				</article>
				<article class="surface stat">
					<p class="stat-label">Devices to review</p>
					<p class="stat-value">3</p>
					<p class="stat-foot">Awaiting approval</p>
				</article>
			</section>

			<section class="content-grid">
				<article class="surface">
					<div class="panel-heading">
						<h2>Recent payments</h2>
						<a href="payments.php">All payments</a>
					</div>
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Tenant / device</th>
									<th>Plan</th>
									<th>Amount</th>
									<th>Status</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>Device · A4:8C:2F</td>
									<td>10 days</td>
									<td>2,000 XAF</td>
									<td>
										<span class="table-status">Paid</span>
									</td>
								</tr>
								<tr>
									<td>Device · 71:BD:09</td>
									<td>30 days</td>
									<td>5,000 XAF</td>
									<td>
										<span class="table-status pending">Pending</span>
									</td>
								</tr>
								<tr>
									<td>Device · C2:54:16</td>
									<td>10 days</td>
									<td>2,000 XAF</td>
									<td>
										<span class="table-status">Paid</span>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</article>
				<article class="surface">
					<div class="panel-heading">
						<h2>Service health</h2>
						<span class="pill mint">Operational</span>
					</div>
					<div class="signal-list">
						<div class="signal">
							<span>Starlink connection</span>
							<strong>Online</strong>
						</div>
						<div class="signal">
							<span>MikroTik router</span>
							<strong>Connected</strong>
						</div>
						<div class="signal">
							<span>Fapshi payments</span>
							<strong>Available</strong>
						</div>
						<div class="signal">
							<span>Portal server</span>
							<strong>Running</strong>
						</div>
					</div>
				</article>
			</section>
		</main>
	</div>
</body>
</html>
