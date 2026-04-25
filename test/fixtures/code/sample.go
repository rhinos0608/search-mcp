package sample

import "strings"

type SampleService struct {
	Prefix string
}

func (s *SampleService) Label(name string) string {
	return formatName(s.Prefix, name)
}

func formatName(prefix string, name string) string {
	trimmed := strings.TrimSpace(name)
	return prefix + ":" + strings.ToLower(trimmed)
}

func buildGreeting(name string) string {
	return formatName("hello", name)
}
