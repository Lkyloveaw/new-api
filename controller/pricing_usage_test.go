package controller

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeCodexUsageSelectsFiveHourAndWeeklyWindows(t *testing.T) {
	input := []byte(`{
		"email":"private@example.com",
		"rate_limit":{
			"primary_window":{"used_percent":37.5,"limit_window_seconds":18000,"reset_at":1793000000},
			"secondary_window":{"used_percent":98,"limit_window_seconds":604800,"reset_at":1793500000}
		}
	}`)

	usage := normalizeCodexUsage(input, 1792970000)

	require.Equal(t, "ok", usage.Status)
	require.Len(t, usage.Windows, 2)
	assert.Equal(t, "5h", usage.Windows[0].Label)
	assert.InDelta(t, 62.5, *usage.Windows[0].RemainingPercent, 0.001)
	assert.Equal(t, int64(1793000000), usage.Windows[0].ResetAt)
	assert.Equal(t, "Weekly", usage.Windows[1].Label)
	assert.InDelta(t, 2, *usage.Windows[1].RemainingPercent, 0.001)
	encoded, err := common.Marshal(usage)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "private@example.com")
}

func TestNormalizeCodexUsageRejectsMissingWindows(t *testing.T) {
	usage := normalizeCodexUsage([]byte(`{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":60}}}`), 1792970000)
	assert.Equal(t, "unavailable", usage.Status)
	assert.Empty(t, usage.Windows)
}

func TestReadAntigravityUsageSnapshot(t *testing.T) {
	now := time.Unix(1792970000, 0)
	path := filepath.Join(t.TempDir(), "quota.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
		"updated_at":1792969990,
		"quota":{
			"gemini-5h":{"remaining_fraction":0.25,"reset_time":"2026-10-26T00:00:00Z"},
			"gemini-weekly":{"remaining_fraction":0.8,"reset_time":"2026-10-30T00:00:00Z"},
			"gemini-count":{"remaining_amount":12}
		}
	}`), 0600))

	usage := readAntigravityUsageSnapshot(path, now)

	require.Equal(t, "ok", usage.Status)
	require.Len(t, usage.Windows, 3)
	assert.Equal(t, "gemini-5h", usage.Windows[0].Label)
	assert.Equal(t, "gemini-5h", usage.Windows[0].Bucket)
	assert.InDelta(t, 25, *usage.Windows[0].RemainingPercent, 0.001)
	assert.Equal(t, "gemini-weekly", usage.Windows[1].Label)
	assert.InDelta(t, 80, *usage.Windows[1].RemainingPercent, 0.001)
	assert.Equal(t, "gemini-count", usage.Windows[2].Label)
	assert.InDelta(t, 12, *usage.Windows[2].RemainingAmount, 0.001)

	freshAtBoundary := readAntigravityUsageSnapshot(path, now.Add(19*time.Minute+50*time.Second))
	assert.Equal(t, "ok", freshAtBoundary.Status)

	stale := readAntigravityUsageSnapshot(path, now.Add(19*time.Minute+51*time.Second))
	assert.Equal(t, "unavailable", stale.Status)
	assert.Empty(t, stale.Windows)
}

func TestAntigravityBucketSelectionKeepsModelsSeparate(t *testing.T) {
	weekly := 80.0
	fiveHour := 25.0
	shared := pricingUsageSnapshot{Source: "antigravity", Status: "ok", UpdatedAt: 1792970000, Windows: []pricingUsageWindow{
		{Label: "5h", Bucket: "gemini-pro-5h", RemainingPercent: &fiveHour},
		{Label: "Weekly", Bucket: "gemini-flash-weekly", RemainingPercent: &weekly},
	}}

	pro := selectAntigravityUsageBuckets(shared, "gemini-pro-5h")
	flash := selectAntigravityUsageBuckets(shared, "gemini-flash-weekly")

	require.Len(t, pro.Windows, 1)
	assert.Equal(t, "gemini-pro-5h", pro.Windows[0].Bucket)
	require.Len(t, flash.Windows, 1)
	assert.Equal(t, "gemini-flash-weekly", flash.Windows[0].Bucket)
	missing := selectAntigravityUsageBuckets(shared, "gemini-unknown")
	assert.Equal(t, "unavailable", missing.Status)
	assert.Empty(t, missing.Windows)
}

func TestPricingUsageResultIncludesOnlyEnabledModelsAndTheirBuckets(t *testing.T) {
	remaining := 40.0
	shared := pricingUsageSnapshot{Source: "antigravity", Status: "ok", UpdatedAt: 1792970000, Windows: []pricingUsageWindow{
		{Label: "pro-weekly", Bucket: "pro-weekly", RemainingPercent: &remaining},
		{Label: "flash-weekly", Bucket: "flash-weekly", RemainingPercent: &remaining},
	}}
	pricing := []model.Pricing{
		{ModelName: "pro", ShowUsage: true, UsageSource: "antigravity", UsageBucketIDs: "pro-weekly"},
		{ModelName: "flash", ShowUsage: true, UsageSource: "antigravity", UsageBucketIDs: "flash-weekly"},
		{ModelName: "hidden", ShowUsage: false, UsageSource: "antigravity", UsageBucketIDs: "pro-weekly"},
	}

	result := buildPricingUsageResult(pricing, nil, shared)

	require.Len(t, result, 2)
	assert.NotContains(t, result, "hidden")
	require.Len(t, result["pro"].Windows, 1)
	assert.Equal(t, "pro-weekly", result["pro"].Windows[0].Bucket)
	require.Len(t, result["flash"].Windows, 1)
	assert.Equal(t, "flash-weekly", result["flash"].Windows[0].Bucket)
}

func TestReadAntigravityUsageSnapshotRejectsInvalidValues(t *testing.T) {
	now := time.Unix(1792970000, 0)
	path := filepath.Join(t.TempDir(), "quota.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
		"updated_at":1792970000,
		"quota":{
			"gemini-5h":{"remaining_fraction":1.5},
			"gemini-weekly":{"remaining_fraction":-0.1}
		}
	}`), 0600))
	usage := readAntigravityUsageSnapshot(path, now)
	assert.Equal(t, "unavailable", usage.Status)
	assert.Empty(t, usage.Windows)
}

func TestCodexUsageFetchRejectsOversizedUpstreamResponse(t *testing.T) {
	client := &http.Client{Transport: usageRoundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 256<<10+1)))}, nil
	})}
	_, _, err := service.FetchCodexWhamUsage(context.Background(), client, "https://example.com", "test-token", "test-account")
	require.ErrorContains(t, err, "response exceeds")
}

type usageRoundTripFunc func(*http.Request) (*http.Response, error)

func (f usageRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
