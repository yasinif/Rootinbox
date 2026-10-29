$env:INSECURE_DEV_MODE = "true"
$env:APP_ORIGIN = "http://localhost:8080"
$env:SERVER_HOST = "0.0.0.0"
$env:SERVER_PORT = "8080"
$env:IP_HASH_SECRET = "dev-secret-key-that-is-at-least-32-bytes-long!!"
$env:PUSH_ENABLED = "false"
$env:TURN_ENABLED = "false"
go run ./cmd/rootinbox
