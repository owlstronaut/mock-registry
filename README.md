# npm-registry-mock-trust

A mock npm registry server for testing trust configurations with OTP (One-Time Password) authentication.

## Features

- Mock trust configuration endpoints (create, list, revoke)
- OTP authentication flow simulation
- Special test packages for error scenarios
- Persistent storage to JSON file
- Debug endpoints for testing

## Installation

```bash
npm install
```

## Usage

### Start the Server

```bash
node index.js
```

The server will start on `http://localhost:3000`

### Configure npm to use the mock registry

```bash
npm config set registry http://localhost:3000
```

### Example Commands

```bash
# Create a trust configuration
npm trust github mypackage --registry=http://localhost:3000 \
  --repository=npm/cli \
  --workflow-ref-file=publish.yml

# List trust configurations
npm trust list mypackage --registry=http://localhost:3000

# Revoke a trust configuration
npm trust revoke mypackage --id=<config-id> --registry=http://localhost:3000
```

## API Endpoints

### Trust Configuration Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/-/package/:package/trust` | Create trust configuration(s) |
| GET | `/-/package/:package/trust` | List trust configurations |
| DELETE | `/-/package/:package/trust/:id` | Revoke a trust configuration |

### Debug Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/debug` | View current trust store state |
| DELETE | `/debug/reset` | Reset all trust configurations |

### OTP Flow Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/:sessionId` | OTP authentication page (auto-sets OTP to 123456) |
| POST | `/auth/:sessionId` | Submit OTP manually |
| GET | `/done/:sessionId` | Poll for OTP completion |

## Special Test Packages

The server supports special package names that trigger specific error scenarios for testing. Use these package names in any API endpoint (GET, POST, DELETE) to simulate different error conditions:

| Package Name | Status Code | Description |
|--------------|-------------|-------------|
| `not-found-package` | 404 | The package doesn't exist in the registry |
| `invalid-private-package-access` | 404 | The package is private and the user doesn't have access (obfuscated - returns 404 instead of 403 to hide the resource's existence) |
| `invalid-public-package-access` | 403 | The package is public but the user doesn't have sufficient permissions to access it |
| `no-2fa-for-user` | 401 | The user authentication is missing or invalid, preventing access to the resource that requires 2FA |
| `valid-private-package-access-readonly` | 200 (GET) / 403 (POST, DELETE) | The package is private and the user has read-only access but not write access |
| `valid-public-package-access-readonly` | 200 (GET) / 403 (POST, DELETE) | The package is public and the user has read-only access but not write access |

**Note:** All special test package responses include an `npm-notice` header with a descriptive message about the test scenario being triggered.

### Example Usage of Special Test Packages

```bash
# Test package not found scenario
npm trust list not-found-package --registry=http://localhost:3000

# Test private package access denial (obfuscated as 404)
npm trust list invalid-private-package-access --registry=http://localhost:3000

# Test public package access denial
npm trust list invalid-public-package-access --registry=http://localhost:3000

# Test missing 2FA authentication
npm trust list no-2fa-for-user --registry=http://localhost:3000

# Test read-only access (GET works, POST/DELETE fail with 403)
npm trust list valid-private-package-access-readonly --registry=http://localhost:3000
npm trust github valid-private-package-access-readonly --repository=npm/cli --workflow-ref-file=publish.yml --registry=http://localhost:3000

# Test public read-only access
npm trust list valid-public-package-access-readonly --registry=http://localhost:3000
npm trust github valid-public-package-access-readonly --repository=npm/cli --workflow-ref-file=publish.yml --registry=http://localhost:3000
```

## OTP Authentication Flow

All trust operations require OTP authentication. The flow works as follows:

1. Request without OTP header returns 401 with `authUrl` and `doneUrl`
2. Client opens `authUrl` in browser (automatically sets OTP to 123456)
3. Client polls `doneUrl` until OTP is ready
4. Client retries original request with `npm-otp` header

Example with curl:

```bash
# Initial request (will return 401 with OTP flow URLs)
curl -X POST http://localhost:3000/-/package/mypackage/trust \
  -H "Content-Type: application/json" \
  -d '[{"type":"github","claims":{"repository":"npm/cli","workflow_ref":{"file":"publish.yml"}}}]'

# After completing OTP flow, retry with OTP header
curl -X POST http://localhost:3000/-/package/mypackage/trust \
  -H "Content-Type: application/json" \
  -H "npm-otp: 123456" \
  -d '[{"type":"github","claims":{"repository":"npm/cli","workflow_ref":{"file":"publish.yml"}}}]'
```

## Trust Configuration Format

### GitHub Trust Configuration

```json
{
  "type": "github",
  "claims": {
    "repository": "npm/cli",
    "workflow_ref": {
      "file": "publish.yml"
    }
  },
  "environment": "production"
}
```

### GitLab Trust Configuration

```json
{
  "type": "gitlab",
  "claims": {
    "project_path": "npm/cli",
    "ci_config_ref_uri": {
      "file": ".gitlab-ci.yml"
    }
  },
  "environment": "production"
}
```

### CircleCI Trust Configuration

```json
{
  "type": "circleci",
  "claims": {
    "oidc.circleci.com/org-id": "c9035eb6-6eb2-4c85-8a81-d9ee6a1fa8c2",
    "oidc.circleci.com/project-id": "ecc458d2-fbdc-4d9a-93c4-ac065ed3c3ca",
    "oidc.circleci.com/pipeline-definition-id": "961ae4b1-070b-4134-ae64-1328a3ae3862",
    "oidc.circleci.com/vcs-origin": "github.com/npm/cli",
    "oidc.circleci.com/context-ids": ["58bef0c1-399d-49ca-a5ba-2f4317e4224d"]
  }
}
```

## Data Storage

Trust configurations are persisted to `trust-store.json` in the project directory. The file is automatically loaded on startup and saved after each modification.

## Development

The server exports the router as a function, allowing it to be integrated into other Express applications:

```javascript
const createTrustRegistryRouter = require('npm-registry-mock-trust');
const express = require('express');

const app = express();
app.use('/custom-path', createTrustRegistryRouter());
app.listen(3000);
```

## License

ISC
