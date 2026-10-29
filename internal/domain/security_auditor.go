package domain

type SecurityAuditor interface {
	Emit(event SecurityEvent)
}
