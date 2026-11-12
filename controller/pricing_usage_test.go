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

	usage := readUsageSnapshot("antigravity", path, now)

	require.Equal(t, "ok", usage.Status)
	require.Len(t, usage.Windows, 3)
	assert.Equal(t, "gemini-5h", usage.Windows[0].Label)
	assert.Equal(t, "gemini-5h", usage.Windows[0].Bucket)
	assert.InDelta(t, 25, *usage.Windows[0].RemainingPercent, 0.001)
	assert.Equal(t, "gemini-weekly", usage.Windows[1].Label)
	assert.InDelta(t, 80, *usage.Windows[1].RemainingPercent, 0.001)
	assert.Equal(t, "gemini-count", usage.Windows[2].Label)
	assert.InDelta(t, 12, *usage.Windows[2].RemainingAmount, 0.001)
	assert.Equal(t, "antigravity", usage.Source)

	freshAtBoundary := readUsageSnapshot("antigravity", path, now.Add(19*time.Minute+50*time.Second))
	assert.Equal(t, "ok", freshAtBoundary.Status)

	stale := readUsageSnapshot("antigravity", path, now.Add(19*time.Minute+51*time.Second))
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

	pro := selectUsageSnapshotBuckets(shared, "gemini-pro-5h")
	flash := selectUsageSnapshotBuckets(shared, "gemini-flash-weekly")

	require.Len(t, pro.Windows, 1)
	assert.Equal(t, "gemini-pro-5h", pro.Windows[0].Bucket)
	require.Len(t, flash.Windows, 1)
	assert.Equal(t, "gemini-flash-weekly", flash.Windows[0].Bucket)
	missing := selectUsageSnapshotBuckets(shared, "gemini-unknown")
	assert.Equal(t, "unavailable", missing.Status)
	assert.Empty(t, missing.Windows)
	assert.Equal(t, "antigravity", missing.Source)
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

	result := buildPricingUsageResult(pricing, nil, map[string]pricingUsageSnapshot{"antigravity": shared})

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
	usage := readUsageSnapshot("antigravity", path, now)
	assert.Equal(t, "unavailable", usage.Status)
	assert.Empty(t, usage.Windows)
}

func TestReadOpenDesignUsageSnapshotKeepsItsOwnFileAndSource(t *testing.T) {
	now := time.Unix(1792970000, 0)
	path := filepath.Join(t.TempDir(), "opendesign-usage.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
		"updated_at":1792969990,
		"quota":{
			"od-5h":{"remaining_fraction":0.9046,"reset_time":"2026-11-12T11:07:44Z"},
			"od-weekly":{"remaining_fraction":0.59739,"reset_time":"2026-11-18T10:07:44Z"}
		}
	}`), 0600))

	usage := readUsageSnapshot("opendesign", path, now)

	require.Equal(t, "ok", usage.Status)
	assert.Equal(t, "opendesign", usage.Source)
	require.Len(t, usage.Windows, 2)
	assert.Equal(t, "od-5h", usage.Windows[0].Bucket)
	assert.InDelta(t, 90.46, *usage.Windows[0].RemainingPercent, 0.001)
	assert.Equal(t, "od-weekly", usage.Windows[1].Bucket)
	assert.InDelta(t, 59.739, *usage.Windows[1].RemainingPercent, 0.001)
}

func TestReadOpenDesignUsageSnapshotRejectsExpiredAndMissingFiles(t *testing.T) {
	now := time.Unix(1792970000, 0)
	dir := t.TempDir()
	path := filepath.Join(dir, "opendesign-usage.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
		"updated_at":1792969990,
		"quota":{"od-5h":{"remaining_fraction":0.5}}
	}`), 0600))

	assert.Equal(t, "ok", readUsageSnapshot("opendesign", path, now).Status)
	expired := readUsageSnapshot("opendesign", path, now.Add(21*time.Minute))
	assert.Equal(t, "unavailable", expired.Status)
	assert.Equal(t, "opendesign", expired.Source)

	missing := readUsageSnapshot("opendesign", filepath.Join(dir, "absent.json"), now)
	assert.Equal(t, "unavailable", missing.Status)
	assert.Empty(t, missing.Windows)

	assert.Equal(t, "unavailable", readUsageSnapshot("opendesign", "", now).Status)
}

func TestOpenDesignSnapshotWithoutWindowsShowsUnavailable(t *testing.T) {
	// An ineligible workspace publishes an empty quota object; it must not become 0%.
	now := time.Unix(1792970000, 0)
	path := filepath.Join(t.TempDir(), "opendesign-usage.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"updated_at":1792969990,"quota":{}}`), 0600))

	usage := readUsageSnapshot("opendesign", path, now)
	assert.Equal(t, "unavailable", usage.Status)
	assert.Empty(t, usage.Windows)
}

func TestFileUsageSourcePathsStaySeparate(t *testing.T) {
	t.Setenv("ANTIGRAVITY_USAGE_FILE", "/usage/antigravity-usage.json")
	t.Setenv("OPENDESIGN_USAGE_FILE", "/usage/custom-opendesign.json")

	assert.Equal(t, "/usage/antigravity-usage.json", fileUsageSnapshotPath("antigravity"))
	assert.Equal(t, "/usage/custom-opendesign.json", fileUsageSnapshotPath("opendesign"))

	// The container default keeps working when the variable is unset.
	t.Setenv("OPENDESIGN_USAGE_FILE", "")
	assert.Equal(t, "/usage/opendesign-usage.json", fileUsageSnapshotPath("opendesign"))
	// The two sources never fall back to each other's variable.
	assert.Equal(t, "/usage/antigravity-usage.json", fileUsageSnapshotPath("antigravity"))
	assert.Equal(t, "", fileUsageSnapshotPath("codex"))
}

func TestPricingUsageResultKeepsSourcesApartPerModel(t *testing.T) {
	fiveHour := 90.46
	remaining := 40.0
	fileUsage := map[string]pricingUsageSnapshot{
		"antigravity": {Source: "antigravity", Status: "ok", UpdatedAt: 1792970000, Windows: []pricingUsageWindow{
			{Label: "gemini-weekly", Bucket: "gemini-weekly", RemainingPercent: &remaining},
		}},
		"opendesign": {Source: "opendesign", Status: "ok", UpdatedAt: 1792970000, Windows: []pricingUsageWindow{
			{Label: "od-5h", Bucket: "od-5h", RemainingPercent: &fiveHour},
		}},
	}
	pricing := []model.Pricing{
		{ModelName: "od-model", ShowUsage: true, UsageSource: "opendesign", UsageBucketIDs: "od-5h"},
		{ModelName: "gemini-model", ShowUsage: true, UsageSource: "antigravity", UsageBucketIDs: "gemini-weekly"},
	}

	result := buildPricingUsageResult(pricing, nil, fileUsage)

	require.Len(t, result, 2)
	assert.Equal(t, "opendesign", result["od-model"].Source)
	require.Len(t, result["od-model"].Windows, 1)
	assert.Equal(t, "od-5h", result["od-model"].Windows[0].Bucket)
	assert.Equal(t, "antigravity", result["gemini-model"].Source)
	require.Len(t, result["gemini-model"].Windows, 1)
	assert.Equal(t, "gemini-weekly", result["gemini-model"].Windows[0].Bucket)
}

func TestOpenDesignBucketSelectionFiltersToConfiguredBuckets(t *testing.T) {
	fiveHour := 90.46
	weekly := 59.739
	shared := pricingUsageSnapshot{Source: "opendesign", Status: "ok", UpdatedAt: 1792970000, Windows: []pricingUsageWindow{
		{Label: "od-5h", Bucket: "od-5h", RemainingPercent: &fiveHour},
		{Label: "od-weekly", Bucket: "od-weekly", RemainingPercent: &weekly},
	}}

	onlyWeekly := selectUsageSnapshotBuckets(shared, "od-weekly")
	require.Len(t, onlyWeekly.Windows, 1)
	assert.Equal(t, "od-weekly", onlyWeekly.Windows[0].Bucket)
	assert.Equal(t, "opendesign", onlyWeekly.Source)

	missing := selectUsageSnapshotBuckets(shared, "od-monthly")
	assert.Equal(t, "unavailable", missing.Status)
	assert.Empty(t, missing.Windows)
	assert.Equal(t, "opendesign", missing.Source)
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
