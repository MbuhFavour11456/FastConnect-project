<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>FastConnect | Owner sign in</title>
	<link rel="stylesheet" href="../assets/style.css">
</head>

<body>
	<main class="auth-shell">
		<section class="surface auth-card">
			<a class="brand" href="../index.html">
				<span class="brand-mark">F</span>
				<span class="brand-name">FastConnect</span>
			</a>

			<p class="eyebrow">Owner portal</p>
			<h1>Sign in</h1>
			<p class="lead">Manage tenant access and payments.</p>

			<form class="form-stack" action="dashboard.php" method="get">
				<label class="field">
					Admin name
					<input type="text" placeholder="Enter admin name" autocomplete="username">
				</label>

				<label class="field">
					Password
					<input type="password" placeholder="Enter your password" autocomplete="current-password">
				</label>
				<button class="button full" type="button">Sign in to dashboard</button>
			</form>
		</section>
	</main>
</body>
</html>
