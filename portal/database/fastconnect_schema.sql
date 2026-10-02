CREATE DATABASE IF NOT EXISTS fastconnect_db;
USE fastconnect_db;

CREATE TABLE admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(30) DEFAULT 'admin',
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    days INT NOT NULL,
    price_xaf INT NOT NULL,
    description TEXT,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_name VARCHAR(120),
    mac_address VARCHAR(64) UNIQUE,
    status VARCHAR(20) DEFAULT 'pending',
    last_seen_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL,
    plan_id INT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    started_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_subscriptions_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscriptions_plan
        FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subscription_id INT,
    device_id INT,
    amount_xaf INT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    payment_reference VARCHAR(120),
    payment_method VARCHAR(80),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payments_subscription
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL,
    CONSTRAINT fk_payments_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE vouchers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(80) NOT NULL UNIQUE,
    value_xaf INT NOT NULL,
    status VARCHAR(20) DEFAULT 'unused',
    device_id INT,
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vouchers_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor VARCHAR(120),
    action VARCHAR(150) NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO plans (name, days, price_xaf, description, is_active)
VALUES
    ('10-Day Plan', 10, 2000, '10 consecutive days of Wi-Fi access', 1),
    ('30-Day Plan', 30, 5000, '30 consecutive days of Wi-Fi access', 1);

INSERT INTO admins (username, password_hash, full_name, role, is_active)
VALUES ('admin', '$2y$12$n9Y7D3xTD6af4QLko8d.q.0mevMZPz7IpzPt05PdKNZO4loQhRmWu', 'The Nkweti''s', 'admin', 1);
