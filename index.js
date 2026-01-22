#!/usr/bin/env node
const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = 3000
const TRUST_STORE_FILE = path.join(__dirname, 'trust-store.json')

// Special test packages that trigger specific error scenarios
const SPECIAL_TEST_PACKAGES = {
  'not-found-package': {
    statusCode: 404,
    error: 'Not found',
    description: 'The package doesn\'t exist in the registry'
  },
  'invalid-private-package-access': {
    statusCode: 404,
    error: 'Not found',
    description: 'The package is private and the user doesn\'t have access (obfuscated)'
  },
  'invalid-public-package-access': {
    statusCode: 403,
    error: 'Forbidden',
    description: 'The package is public but the user doesn\'t have sufficient permissions'
  },
  'no-2fa-for-user': {
    statusCode: 401,
    error: 'Unauthorized',
    description: 'The user authentication is missing or invalid, preventing access to the resource that requires 2FA'
  },
  'valid-private-package-access-readonly': {
    statusCode: 403,
    error: 'Forbidden',
    description: 'The package is private and the user has read-only access but not write access',
    readOnly: true
  },
  'valid-public-package-access-readonly': {
    statusCode: 403,
    error: 'Forbidden',
    description: 'The package is public and the user has read-only access but not write access',
    readOnly: true
  }
}

// Helper function to check if a package name is a special test package
function checkSpecialTestPackage(packageName) {
  return SPECIAL_TEST_PACKAGES[packageName] || null
}

// Create the trust registry router as a function
function createTrustRegistryRouter() {
  const router = express.Router()

  // In-memory storage for trust configurations
  // Structure: { 'package-name': [{ id, type, claims, environment?, created }] }
  // Example github format:
  // {
  //   id: '0fcc02343b9260626f69fa0a16135134',
  //   type: 'github',
  //   claims: {
  //     repository: 'npm/cli',
  //     workflow_ref: {
  //       file: 'publish.yml'
  //     }
  //   },
  //   environment: 'production', // optional
  //   created: '2026-01-08T00:00:00.000Z'
  // }
  // Example gitlab format:
  // {
  //   id: 'abc123def456789012345678901234567',
  //   type: 'gitlab',
  //   claims: {
  //     project_path: 'npm/cli',
  //     ci_config_ref_uri: {
  //       file: '.gitlab-ci.yml'
  //     }
  //   },
  //   environment: 'production', // optional
  //   created: '2026-01-08T00:00:00.000Z'
  // }
  // Example circleci format:
  // {
  //   id: 'def456abc789012345678901234567890',
  //   type: 'circleci',
  //   claims: {
  //     'oidc.circleci.com/org-id': 'c9035eb6-6eb2-4c85-8a81-d9ee6a1fa8c2',
  //     'oidc.circleci.com/project-id': 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  //     'oidc.circleci.com/pipeline-definition-id': '961ae4b1-070b-4134-ae64-1328a3ae3862',
  //     'oidc.circleci.com/vcs-origin': 'github.com/npm/trust-publish-test',
  //     'oidc.circleci.com/context-ids': ['58bef0c1-399d-49ca-a5ba-2f4317e4224d'] // optional, array of UUIDs
  //   },
  //   created: '2026-01-08T00:00:00.000Z'
  // }
  let trustStore = {}

  // Load trust store from file on startup
  function loadTrustStore() {
    try {
      if (fs.existsSync(TRUST_STORE_FILE)) {
        const data = fs.readFileSync(TRUST_STORE_FILE, 'utf8')
        trustStore = JSON.parse(data)
        console.log(`✓ Loaded trust store from ${TRUST_STORE_FILE}`)
        const totalConfigs = Object.values(trustStore).reduce((sum, configs) => sum + configs.length, 0)
        console.log(`  Found ${Object.keys(trustStore).length} package(s) with ${totalConfigs} total config(s)`)
      } else {
        console.log(`ℹ No existing trust store file found, starting fresh`)
      }
    } catch (err) {
      console.error(`⚠ Error loading trust store: ${err.message}`)
      trustStore = {}
    }
  }

  // Save trust store to file
  function saveTrustStore() {
    try {
      fs.writeFileSync(TRUST_STORE_FILE, JSON.stringify(trustStore, null, 2), 'utf8')
      console.log(`✓ Saved trust store to ${TRUST_STORE_FILE}`)
    } catch (err) {
      console.error(`⚠ Error saving trust store: ${err.message}`)
    }
  }

  // Load trust store on startup
  loadTrustStore()

  // Helper function to generate a unique ID
  function generateId() {
    return crypto.randomBytes(16).toString('hex')
  }

  // In-memory OTP store
  const otps = {};

  // Helper to generate a random session ID
  function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
  }

  // Serve the OTP entry page
  router.get('/auth/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    // Automatically set OTP to 123456
    otps[sessionId] = '123456';
    console.log(`✓ Auto-set OTP for session ${sessionId}: 123456`);
    res.send(`
    <html>
      <body>
        <h2>Authentication Complete</h2>
        <p>OTP has been automatically set to: 123456</p>
        <p>You can close this window now.</p>
      </body>
    </html>
  `);
  });

  // Handle OTP submission
  router.post('/auth/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { otp } = req.body;
    console.log(`✓ OTP received for session ${sessionId}: ${otp}`);
    otps[sessionId] = otp;
    res.status(200).json({ otp });
  });

  // Polling endpoint to check if OTP is done
  router.get('/done/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    // Add a delay to slow down polling
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (otps[sessionId]) {
      res.status(200).json({ token: otps[sessionId] });
    } else {
      res.status(202).json({ status: 'pending' });
    }
  });

  // Require OTP for trust creation
  router.post('/-/package/:package/trust', (req, res) => {
    const packageName = decodeURIComponent(req.params.package);
    
    // Check if this is a special test package
    const specialPackage = checkSpecialTestPackage(packageName);
    if (specialPackage) {
      console.log(`✗ Special test package triggered: ${packageName}`);
      res.setHeader('npm-notice', `Test Scenario: ${specialPackage.description}`);
      return res.status(specialPackage.statusCode).json({
        error: specialPackage.error,
        message: specialPackage.description
      });
    }
    
    const configs = req.body;
    const otp = req.header('npm-otp');

    if (!otp) {
      // No OTP provided, start OTP flow
      const sessionId = generateSessionId();
      const authUrl = `http://localhost:${PORT}/auth/${sessionId}`;
      const doneUrl = `http://localhost:${PORT}/done/${sessionId}`;
      console.log(`⚠ OTP required for ${packageName}. Session: ${sessionId}`);
      console.log(`  authUrl: ${authUrl}`);
      console.log(`  doneUrl: ${doneUrl}`);
      return res.status(401).json({
        error: 'OTP required',
        authUrl,
        doneUrl
      });
    }

    // Validate OTP (for demo, accept any non-empty OTP)
    // You could add more logic here to check against otps/session if needed
    if (!otp || typeof otp !== 'string' || otp.length < 4) {
      return res.status(401).json({ error: 'Invalid OTP', code: 'EOTP' });
    }

    console.log(`Creating trust config for package: ${packageName}`);
    console.log('Received configs:', JSON.stringify(configs, null, 2));

    if (!Array.isArray(configs)) {
      return res.status(400).json({ error: 'Request body must be an array of trust configurations' });
    }

    // Initialize package trust store if it doesn't exist
    if (!trustStore[packageName]) {
      trustStore[packageName] = [];
    }

    // Process each config
    const results = configs.map(config => {
      const id = generateId();
      const trustConfig = {
        id,
        ...config,
        created: new Date().toISOString(),
      };
      trustStore[packageName].push(trustConfig);
      console.log(`✓ Created trust config with ID: ${id}`);
      return trustConfig;
    });

    console.log(`Current trust configs for ${packageName}:`, trustStore[packageName].length);

    // Save to file
    saveTrustStore();

    res.status(201).json(results.length === 1 ? results[0] : results);
  });

  // GET /-/package/:package/trust
  // List all trust configurations for a package
  router.get('/-/package/:package/trust', (req, res) => {
    const packageName = decodeURIComponent(req.params.package)
    
    // Check if this is a special test package
    const specialPackage = checkSpecialTestPackage(packageName)
    if (specialPackage) {
      // For read-only packages, allow GET requests but deny write operations
      if (specialPackage.readOnly) {
        console.log(`✓ Read-only access allowed for GET: ${packageName}`)
        res.setHeader('npm-notice', `Test Scenario: ${specialPackage.description} - Read access granted`);
        // Return empty array or mock data for read-only packages
        return res.status(200).json([])
      }
      // For other special packages, return the error
      console.log(`✗ Special test package triggered: ${packageName}`)
      res.setHeader('npm-notice', `Test Scenario: ${specialPackage.description}`);
      return res.status(specialPackage.statusCode).json({
        error: specialPackage.error,
        message: specialPackage.description
      })
    }
    
    const otp = req.header('npm-otp')
    
    console.log(`Listing trust configs for package: ${packageName}`)

    if (!otp) {
      // No OTP provided, start OTP flow
      const sessionId = generateSessionId();
      const authUrl = `http://localhost:${PORT}/auth/${sessionId}`;
      const doneUrl = `http://localhost:${PORT}/done/${sessionId}`;
      console.log(`⚠ OTP required for ${packageName}. Session: ${sessionId}`);
      console.log(`  authUrl: ${authUrl}`);
      console.log(`  doneUrl: ${doneUrl}`);
      return res.status(401).json({
        error: 'OTP required',
        authUrl,
        doneUrl
      });
    }

    // Validate OTP (for demo, accept any non-empty OTP)
    if (!otp || typeof otp !== 'string' || otp.length < 4) {
      return res.status(401).json({ error: 'Invalid OTP', code: 'EOTP' });
    }

    const configs = trustStore[packageName] || [];
    console.log(`✓ Found ${configs.length} trust config(s) for ${packageName}`);
    res.status(200).json(configs);
  });

  // DELETE /-/package/:package/trust/:id
  // Revoke (delete) a trust configuration
  router.delete('/-/package/:package/trust/:id', (req, res) => {
    const packageName = decodeURIComponent(req.params.package)
    const trustId = decodeURIComponent(req.params.id)
    
    // Check if this is a special test package
    const specialPackage = checkSpecialTestPackage(packageName)
    if (specialPackage) {
      console.log(`✗ Special test package triggered: ${packageName}`)
      res.setHeader('npm-notice', `Test Scenario: ${specialPackage.description}`);
      return res.status(specialPackage.statusCode).json({
        error: specialPackage.error,
        message: specialPackage.description
      })
    }
    
    const otp = req.header('npm-otp')

    console.log(`Revoking trust config ${trustId} for package: ${packageName}`)

    if (!otp) {
      // No OTP provided, start OTP flow
      const sessionId = generateSessionId();
      const authUrl = `http://localhost:${PORT}/auth/${sessionId}`;
      const doneUrl = `http://localhost:${PORT}/done/${sessionId}`;
      console.log(`⚠ OTP required for ${packageName}. Session: ${sessionId}`);
      console.log(`  authUrl: ${authUrl}`);
      console.log(`  doneUrl: ${doneUrl}`);
      return res.status(401).json({
        error: 'OTP required',
        authUrl,
        doneUrl
      });
    }

    // Validate OTP (for demo, accept any non-empty OTP)
    if (!otp || typeof otp !== 'string' || otp.length < 4) {
      return res.status(401).json({ error: 'Invalid OTP', code: 'EOTP' });
    }

    if (!trustStore[packageName]) {
      console.log(`⚠ Package ${packageName} not found (treating as already revoked)`)
      // Return success even if package doesn't exist (idempotent operation)
      return res.status(200).json({ success: true, message: 'Trust configuration not found (already revoked)' })
    }

    const initialLength = trustStore[packageName].length
    trustStore[packageName] = trustStore[packageName].filter(config => config.id !== trustId)
    
    if (trustStore[packageName].length === initialLength) {
      console.log(`⚠ Trust config with ID ${trustId} not found (treating as already revoked)`)
      // Return success even if trust config doesn't exist (idempotent operation)
      return res.status(200).json({ success: true, message: 'Trust configuration not found (already revoked)' })
    }

    console.log(`✓ Successfully revoked trust config ${trustId}`)
    console.log(`Remaining configs for ${packageName}:`, trustStore[packageName].length)

    // Save to file
    saveTrustStore();

    res.status(200).json({ success: true, message: 'Trust configuration revoked' })
  })

  // GET /-/package/:package
  // Mock package metadata endpoint (optional, for compatibility)
  router.get('/-/package/:package', (req, res) => {
    const packageName = decodeURIComponent(req.params.package)
    console.log(`Getting package metadata for: ${packageName}`)
    
    res.status(200).json({
      name: packageName,
      'dist-tags': {
        latest: '1.0.0',
      },
      versions: {
        '1.0.0': {
          name: packageName,
          version: '1.0.0',
        },
      },
    })
  })

  // GET /debug
  // Debug endpoint to view current state
  router.get('/debug', (req, res) => {
    console.log('Debug endpoint accessed')
    res.status(200).json({
      trustStore,
      packages: Object.keys(trustStore),
      totalConfigs: Object.values(trustStore).reduce((sum, configs) => sum + configs.length, 0),
    })
  })

  // DELETE /debug/reset
  // Reset the trust store (for testing)
  router.delete('/debug/reset', (req, res) => {
    console.log('Resetting trust store')
    Object.keys(trustStore).forEach(key => delete trustStore[key])
    saveTrustStore();
    res.status(200).json({ success: true, message: 'Trust store reset' })
  })

  return router
}

// If running directly, start the server
if (require.main === module) {
  const app = express()

  // Middleware
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`)
    if (req.body && Object.keys(req.body).length > 0) {
      console.log('Body:', JSON.stringify(req.body, null, 2))
    }
    next()
  })

  // Mount the trust registry router at root path
  // To mount at a different path, use: app.use('/hello', createTrustRegistryRouter())
  app.use('/', createTrustRegistryRouter())

  // Error handling
  app.use((err, req, res, next) => {
    console.error('Error:', err.message)
    res.status(500).json({ error: err.message })
  })

  // 404 handler
  app.use((req, res) => {
    console.log(`✗ Route not found: ${req.method} ${req.path}`)
    res.status(404).json({ error: 'Not found' })
  })

  // Start server
  app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`)
    console.log('Mock Trust Registry Server')
    console.log(`${'='.repeat(60)}`)
    console.log(`\n✓ Server running at http://localhost:${PORT}`)
    console.log(`\nEndpoints:`)
    console.log(`  POST   /-/package/:package/trust       Create trust config`)
    console.log(`  GET    /-/package/:package/trust       List trust configs`)
    console.log(`  DELETE /-/package/:package/trust/:id   Revoke trust config`)
    console.log(`  GET    /debug                          View current state`)
    console.log(`  DELETE /debug/reset                    Reset all data`)
    console.log(`\nUsage:`)
    console.log(`  npm trust github mypackage --registry=http://localhost:3000 [options]`)
    console.log(`  npm trust gitlab mypackage --registry=http://localhost:3000 [options]`)
    console.log(`  npm trust circleci mypackage --registry=http://localhost:3000 --org-id <uuid> --project-id <uuid> --pipeline-definition-id <uuid> --vcs-origin <origin> [--context-id <uuid>...]`)
    console.log(`  npm trust list mypackage --registry=http://localhost:3000`)
    console.log(`  npm trust revoke mypackage --id=<id> --registry=http://localhost:3000`)
    console.log(`\n${'='.repeat(60)}\n`)
  })
}

// Export the router function for use in other modules
module.exports = createTrustRegistryRouter
