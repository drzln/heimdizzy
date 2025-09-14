# Heimdizzy SQLx Support

Heimdizzy now has built-in support for SQLx offline mode, making it easy to use compile-time checked SQL queries in Rust services.

## Overview

SQLx is a Rust SQL toolkit that provides compile-time checked queries. However, these queries require database access during compilation, which creates challenges for Docker builds. Heimdizzy's SQLx support automates the process of generating offline query metadata.

## Configuration

Add the `sqlx` configuration to your service's `build` section in `heimdizzy.yml`:

```yaml
build:
  dockerfile: Dockerfile
  platform: x86_64
  binaryName: my-service
  sqlx:
    enabled: true
    database:
      migrationsPath: migrations      # Path to SQL migrations
      port: 15432                     # Local PostgreSQL port
    prepare:
      autoGenerate: true              # Auto-generate .sqlx directory
      cacheDirectory: .sqlx           # SQLx cache directory
      dockerImage: postgres:15-alpine # PostgreSQL image to use
```

You can also override SQLx configuration for specific deployments:

```yaml
deployments:
  - name: my-service-staging
    environment: staging
    build:
      dockerfile: Dockerfile.staging.deploy
      sqlx:
        enabled: true
        database:
          migrationsPath: migrations
          port: 15432
```

## How It Works

When SQLx is enabled, Heimdizzy will:

1. **Start PostgreSQL**: Launches a temporary PostgreSQL container
2. **Run Migrations**: Applies all SQL migrations from the configured directory
3. **Generate Metadata**: Runs `cargo sqlx prepare` to generate query metadata
4. **Fix Common Issues**: Automatically adds missing features like `bigdecimal` if needed
5. **Cleanup**: Removes the temporary PostgreSQL container

The generated `.sqlx` directory contains cached query metadata that allows SQLx to compile without database access.

## Prerequisites

### Cargo.toml Configuration

Ensure your service has the required SQLx features:

```toml
[dependencies]
sqlx = { version = "0.7", features = [
    "runtime-tokio-rustls",
    "postgres",
    "uuid",
    "chrono",
    "json",
    "bigdecimal"  # Required for DECIMAL columns
]}
```

### Dockerfile Configuration

Your Dockerfile should:
1. Copy the `.sqlx` directory for offline compilation
2. Set `SQLX_OFFLINE=true` environment variable

```dockerfile
# Copy SQLx metadata for offline compilation
COPY .sqlx ./.sqlx

# Enable SQLx offline mode
ENV SQLX_OFFLINE=true

# Build the service
RUN cargo build --release
```

## Migration Files

Place your SQL migrations in the configured directory (default: `migrations/`):

```
migrations/
├── 001_initial_schema.sql
├── 002_add_indexes.sql
└── 003_add_triggers.sql
```

Migrations are applied in alphabetical order.

## Troubleshooting

### Common Issues

1. **Missing `bigdecimal` feature**: Heimdizzy will automatically add this if it detects `rust_decimal` in your dependencies

2. **Compilation errors**: If SQLx prepare fails with compilation errors but generates metadata, Heimdizzy will continue. Check that your:
   - Database schema matches your Rust types
   - All required columns exist in the database
   - Nullable columns are properly handled with `Option<T>`

3. **Port conflicts**: The default port is 15432 to avoid conflicts with local PostgreSQL. You can change this in the configuration.

### Manual SQLx Preparation

If automatic preparation fails, you can manually generate the cache:

```bash
# Install sqlx-cli if not already installed
cargo install sqlx-cli --no-default-features --features postgres

# Set up database
docker run -d --name temp-postgres \
  -e POSTGRES_USER=myservice \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=myservice \
  -p 15432:5432 \
  postgres:15-alpine

# Run migrations
DATABASE_URL="postgresql://myservice:password@localhost:15432/myservice"
for file in migrations/*.sql; do
  psql $DATABASE_URL < $file
done

# Generate SQLx metadata
export DATABASE_URL
export SQLX_OFFLINE=false
cargo sqlx prepare

# Cleanup
docker rm -f temp-postgres
```

## Best Practices

1. **Commit `.sqlx` directory**: Always commit the generated `.sqlx` directory to version control

2. **Keep migrations idempotent**: Use `CREATE TABLE IF NOT EXISTS` and similar patterns

3. **Match Rust and SQL types**: Ensure your Rust models match database column types exactly

4. **Handle nullable columns**: Use `Option<T>` for nullable database columns

5. **Test locally**: Run `heimdizzy build` locally before pushing to ensure SQLx preparation works

## Example Service

Here's a complete example of a service using SQLx with Heimdizzy:

### heimdizzy.yml
```yaml
version: "1.0"

service:
  name: payment-service
  type: container

build:
  dockerfile: Dockerfile
  platform: x86_64
  sqlx:
    enabled: true
    database:
      migrationsPath: migrations

deployments:
  - name: payment-staging
    environment: staging
    # ... rest of deployment config
```

### Cargo.toml
```toml
[dependencies]
sqlx = { version = "0.7", features = ["runtime-tokio-rustls", "postgres", "uuid", "chrono", "json", "bigdecimal"] }
rust_decimal = { version = "1.26", features = ["serde", "postgres"] }
```

### Dockerfile
```dockerfile
FROM rustlang/rust:nightly-alpine AS builder

WORKDIR /build
COPY . .
COPY .deps/ ./.deps/
COPY .sqlx ./.sqlx

ENV SQLX_OFFLINE=true
RUN cargo build --release --target x86_64-unknown-linux-musl

FROM gcr.io/distroless/static
COPY --from=builder /build/target/x86_64-unknown-linux-musl/release/payment-service /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/payment-service"]
```

## SQLx Query Macros

With offline mode enabled, you can use compile-time checked queries:

```rust
// This query is validated at compile time
let user = sqlx::query!(
    r#"
    SELECT id, email, created_at
    FROM users
    WHERE email = $1 AND product = $2
    "#,
    email,
    product
)
.fetch_optional(&pool)
.await?;

// Type-safe access to results
println!("User {} created at {}", user.email, user.created_at);
```

The SQLx cache ensures these queries compile without database access during Docker builds.