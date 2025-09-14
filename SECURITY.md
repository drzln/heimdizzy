# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in Heimdizzy, please report it by emailing security@heimdizzy.io. Please do not report security vulnerabilities through public GitHub issues.

## Security Best Practices

When using Heimdizzy in production:

### 1. Credential Management

- **Never commit credentials** to version control
- Use environment variables for all sensitive values
- Rotate credentials regularly
- Use IAM roles when possible instead of static credentials

### 2. Environment Variables

Required environment variables should be set securely:

```bash
# Copy the example file
cp .env.example .env

# Edit with your actual values
# NEVER commit the .env file
```

### 3. Discord Webhooks

- Keep webhook URLs secret
- Rotate webhooks if compromised
- Use separate webhooks for each environment

### 4. Container Registry Security

- Use private registries for sensitive images
- Enable registry authentication
- Scan images for vulnerabilities
- Use image signing when possible

### 5. Kubernetes Security

- Use RBAC for service accounts
- Limit pod permissions
- Use network policies
- Enable pod security policies

### 6. Storage Security

- Enable S3 bucket encryption
- Use IAM policies to limit access
- Enable versioning for critical artifacts
- Regular security audits of bucket policies

## Security Checklist

Before deploying to production:

- [ ] All credentials are in environment variables
- [ ] No secrets in configuration files
- [ ] Container images are scanned
- [ ] Network policies are configured
- [ ] RBAC is properly configured
- [ ] Audit logging is enabled
- [ ] Webhook URLs are secured
- [ ] Storage buckets are encrypted

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Updates

Security updates will be released as patch versions. Update regularly:

```bash
npm update heimdizzy
```